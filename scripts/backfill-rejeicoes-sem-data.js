#!/usr/bin/env node
/**
 * scripts/backfill-rejeicoes-sem-data.js
 *
 * Re-coleta os detalhes das linhas de `note_rejections` que estão SEM
 * `rejection_date` (o RejectedAt da WPA). Preenche também `motivo_codes`,
 * `motivo_textos`, `observacao` e `formulario` quando vierem.
 *
 * Por que precisa de um script separado: o `runClassifyRejections` e o
 * `scripts/backfill-rejections.js` filtram por PRESENÇA na tabela
 * (`services/cronService.js` ~660: `jobs.filter(j => !jaCache.has(j.note_id))`).
 * As linhas de VL/SM já existem — foram gravadas com `endpoint_missing` porque o
 * tipo não estava em CANDIDATE_PATHS e nenhuma chamada era feita. Então o retry
 * normal nunca volta nelas.
 *
 * Contexto (21/08/2026): a medição do P0-8 mostrou VL com 1278 rejeições e 100%
 * sem RejectedAt, contra ~0% nos outros tipos. Sem o RejectedAt, o
 * `_rejIndexByNote` cai pro `session_date` — "o dia em que o coletor VIU a
 * rejeição" — que com o arrasto entre snapshots pode estar 1 dia à frente do
 * fato e SUPRIMIR produção legítima (backlog P2-32).
 *
 * ⚠️ Custo de rede na conta compartilhada da EDP (ver P1-25): 1 request por nota
 * quando o path é descoberto de primeira. Se NENHUM candidato funcionar pro tipo,
 * o cache negativo (`_noPathForTipo`) faz só a PRIMEIRA nota pagar a lista
 * inteira; as demais saem sem request. Rode fora do horário de pico.
 *
 * Uso (na VM):
 *   node -r dotenv/config scripts/backfill-rejeicoes-sem-data.js --dry-run
 *   node -r dotenv/config scripts/backfill-rejeicoes-sem-data.js --tipo VL --limite 20
 *   node -r dotenv/config scripts/backfill-rejeicoes-sem-data.js --tipo VL
 *   node -r dotenv/config scripts/backfill-rejeicoes-sem-data.js
 *
 * SEMPRE comece com `--dry-run`, depois `--limite 20` num tipo só, confira o
 * resultado, e só então rode inteiro.
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
}
const flag = nome => process.argv.includes(`--${nome}`);

const DRY    = flag('dry-run');
const TIPO   = arg('tipo', null);
const LIMITE = Number(arg('limite', 0)) || 0;
const CONC   = Number(arg('conc', 3)) || 3;   // conservador: conta compartilhada

async function main() {
  const { _getPool } = require('../services/pgShim');
  const { fetchRejectionDetails, getDiscoveredPaths, getNoPathTipos } =
    require('../services/rejectionService');
  const pool = _getPool();
  if (!pool) {
    console.error('Sem pool. Rode com `node -r dotenv/config` na VM.');
    process.exit(1);
  }

  const where = ['rejection_date IS NULL'];
  const params = [];
  if (TIPO) { params.push(TIPO.toUpperCase()); where.push(`tipo = $${params.length}`); }

  const { rows: alvo } = await pool.query(
    `SELECT note_id::text AS note_id, numero, tipo, team_name, session_date::text AS session_date
       FROM note_rejections
      WHERE ${where.join(' AND ')}
      ORDER BY session_date DESC` + (LIMITE ? ` LIMIT ${LIMITE}` : ''),
    params);

  console.log(`\n=== Backfill de rejeições sem RejectedAt ===`);
  console.log(`alvo: ${alvo.length} linhas${TIPO ? ` (tipo=${TIPO})` : ''}${LIMITE ? ` [limite ${LIMITE}]` : ''}`);

  const porTipo = {};
  alvo.forEach(r => { porTipo[r.tipo] = (porTipo[r.tipo] || 0) + 1; });
  console.log(`por tipo: ${Object.entries(porTipo).map(([t, n]) => `${t}=${n}`).join('  ') || '—'}`);

  if (alvo.length === 0) { await pool.end(); return; }

  if (DRY) {
    console.log(`\n--dry-run: nada foi alterado. Amostra dos 10 primeiros:`);
    alvo.slice(0, 10).forEach(r =>
      console.log(`  ${r.tipo}  ${r.numero || r.note_id.slice(0, 8)}  ${r.team_name}  ${r.session_date}`));
    console.log(`\nCusto estimado: até ${alvo.length} requests (1/nota) se o path for`);
    console.log(`descoberto de primeira; o cache negativo evita repetir a varredura.`);
    await pool.end();
    return;
  }

  let comData = 0, comMotivo = 0, semNada = 0, erro = 0;
  const t0 = Date.now();

  for (let i = 0; i < alvo.length; i += CONC) {
    const lote = alvo.slice(i, i + CONC);
    const dets = await Promise.all(lote.map(async r => {
      try { return { r, det: await fetchRejectionDetails(r.note_id, r.tipo) }; }
      catch (err) { return { r, err }; }
    }));

    for (const { r, det, err } of dets) {
      if (err) { erro++; continue; }
      const temData   = Boolean(det && det.rejection_date);
      const temMotivo = Boolean(det && det.motivo_codes && det.motivo_codes.length);
      if (!temData && !temMotivo) { semNada++; continue; }
      if (temData)   comData++;
      if (temMotivo) comMotivo++;

      // UPDATE, não upsert: a linha já existe e só queremos ENRIQUECER.
      // Nunca sobrescreve com nulo o que já estava preenchido (COALESCE).
      await pool.query(
        `UPDATE note_rejections
            SET rejection_date = COALESCE($2, rejection_date),
                motivo_codes   = CASE WHEN cardinality($3::text[]) > 0
                                      THEN $3::text[] ELSE motivo_codes END,
                motivo_textos  = CASE WHEN cardinality($4::text[]) > 0
                                      THEN $4::text[] ELSE motivo_textos END,
                observacao     = COALESCE($5, observacao),
                formulario     = COALESCE($6, formulario),
                raw            = COALESCE($7::jsonb, raw),
                fetched_at     = now()
          WHERE note_id = $1::uuid`,
        [r.note_id, det.rejection_date || null,
         det.motivo_codes || [], det.motivo_textos || [],
         det.observacao || null, det.formulario || null,
         det.raw ? JSON.stringify(det.raw) : null]);
    }

    if ((i + CONC) % 60 < CONC) {
      console.log(`  ${Math.min(i + CONC, alvo.length)}/${alvo.length}  ` +
                  `data=${comData} motivo=${comMotivo} vazio=${semNada} erro=${erro}`);
    }
  }

  console.log(`\n── RESULTADO (${Math.round((Date.now() - t0) / 1000)}s) ──`);
  console.log(`ganharam rejection_date: ${comData}`);
  console.log(`ganharam motivo_codes:   ${comMotivo}`);
  console.log(`voltaram vazias:         ${semNada}`);
  console.log(`erro:                    ${erro}`);
  console.log(`\npaths descobertos: ${JSON.stringify(getDiscoveredPaths())}`);
  console.log(`tipos sem path (cache negativo): ${JSON.stringify(getNoPathTipos())}`);

  if (comData > 0) {
    console.log(`\n⚠️ ${comData} linhas ganharam data autoritativa — a regra`);
    console.log(`   rejeitada>concluída pode mudar de resultado nessas notas.`);
    console.log(`   Rode o dry-run da re-consolidação para MEDIR o delta antes de aplicar.`);
  }

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
