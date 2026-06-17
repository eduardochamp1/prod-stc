#!/usr/bin/env node
/**
 * scripts/diag-audit.js
 * AUDITORIA READ-ONLY da correção dos dados extraídos do WPA.
 *
 * Objetivo: responder "temos certeza que os dados estão corretos?" sem tocar
 * a EDP nem alterar nada. Faz SÓ SELECTs no Postgres local. Roda em segundos.
 *
 * Uso (na VM):
 *   cd ~/prod-stc && node scripts/diag-audit.js
 *
 * Cobre 6 frentes:
 *   1. Cobertura de snapshots de hoje (o cron de 15 min tem buracos? = falha silenciosa)
 *   2. Saúde do token WPA (expirado = coleta parada sem erro)
 *   3. Proxy de falha silenciosa (equipes com sessão ABERTA e TODOS os buckets zerados)
 *   4. Cobertura de classificação (quanto cai em OUTROS por tipo)
 *   5. INVESTIGAÇÃO DA REGRA "RAMAL BT" — quantas notas com atividade C93 foram
 *      jogadas em OUTROS, e dessas, quantas o Address realmente NÃO tem "RAMAL BT"
 *   6. Estado dos crons de auto-verificação (drift, subcat_error)
 *
 * Não builda nada. Não escreve nada. Seguro rodar a qualquer hora.
 */

require('dotenv').config({ override: true });

const { dateBRT, dateBRTMinusDays } = require('../services/timeUtil');

// Conexão: reutiliza o pool do app (pgShim lê DATABASE_URL do .env).
let pool;
try {
  pool = require('../services/pgShim')._getPool();
} catch (err) {
  console.error('\n[diag-audit] Não consegui abrir o pool Postgres:', err.message);
  console.error('[diag-audit] Este script exige DATABASE_URL no .env (Postgres local).\n');
  process.exit(1);
}

// ── helpers de apresentação ────────────────────────────────────────────────
const H  = (s) => console.log(`\n${'═'.repeat(70)}\n  ${s}\n${'═'.repeat(70)}`);
const ok   = (s) => console.log(`  ✅ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const bad  = (s) => console.log(`  🔴 ${s}`);
const info = (s) => console.log(`     ${s}`);
const pct  = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0') + '%';

async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Roda uma seção isolada — se a query falhar, reporta e segue (não derruba tudo).
async function section(title, fn) {
  H(title);
  try { await fn(); }
  catch (err) { bad(`falhou: ${err.message}`); }
}

async function main() {
  const hoje  = dateBRT();
  const d30   = dateBRTMinusDays(30);

  H(`AUDITORIA DE CORREÇÃO DOS DADOS WPA — ${hoje} (BRT)`);
  const idn = await q('SELECT current_database() AS db, now() AS agora');
  info(`banco=${idn[0].db}  now=${new Date(idn[0].agora).toISOString()}`);

  // ── 1. COBERTURA DE SNAPSHOTS DE HOJE ─────────────────────────────────────
  await section('1. COBERTURA DE SNAPSHOTS DE HOJE (cron a cada 15 min, 06–20h)', async () => {
    const slots = await q(
      `WITH s AS (
         SELECT DISTINCT date_trunc('minute', captured_at AT TIME ZONE 'America/Sao_Paulo') AS slot
         FROM snapshots WHERE date = $1)
       SELECT count(*)::int AS n,
              to_char(min(slot),'HH24:MI') AS primeiro,
              to_char(max(slot),'HH24:MI') AS ultimo
       FROM s`, [hoje]);
    const { n, primeiro, ultimo } = slots[0];
    if (n === 0) { bad('NENHUM snapshot hoje — cron de coleta parado ou sem dados.'); return; }
    info(`${n} capturas hoje  |  primeira ${primeiro}  →  última ${ultimo}`);

    // Buracos > 20 min no horário comercial (06–20h) indicam cron pulando ciclos.
    const gaps = await q(
      `WITH s AS (
         SELECT DISTINCT date_trunc('minute', captured_at AT TIME ZONE 'America/Sao_Paulo') AS slot
         FROM snapshots WHERE date = $1),
       o AS (SELECT slot, lag(slot) OVER (ORDER BY slot) AS prev FROM s)
       SELECT to_char(prev,'HH24:MI') AS de, to_char(slot,'HH24:MI') AS ate,
              round(EXTRACT(EPOCH FROM (slot - prev))/60)::int AS gap_min
       FROM o
       WHERE prev IS NOT NULL
         AND slot - prev > interval '20 minutes'
         AND EXTRACT(hour FROM prev) BETWEEN 6 AND 20
       ORDER BY slot`, [hoje]);
    if (gaps.length === 0) ok('Sem buracos > 20 min no horário comercial.');
    else {
      warn(`${gaps.length} buraco(s) > 20 min entre capturas (cron pode ter pulado ciclos):`);
      gaps.forEach(g => info(`${g.de} → ${g.ate}  (${g.gap_min} min sem snapshot)`));
    }

    const teams = await q(
      `SELECT count(DISTINCT team_name)::int AS n FROM snapshots WHERE date = $1`, [hoje]);
    info(`equipes distintas capturadas hoje: ${teams[0].n}`);
  });

  // ── 2. SAÚDE DO TOKEN WPA ─────────────────────────────────────────────────
  await section('2. SAÚDE DO TOKEN WPA (expirado = coleta para em silêncio)', async () => {
    const t = await q(`SELECT key, expires_at, updated_at FROM wpa_token`);
    if (t.length === 0) { warn('tabela wpa_token vazia — token só em memória?'); return; }
    for (const row of t) {
      const exp = new Date(row.expires_at);
      const mins = Math.round((exp - Date.now()) / 60000);
      const linha = `key=${row.key}  expira=${exp.toISOString()}  (${mins} min)`;
      if (mins < 0)      bad(`TOKEN EXPIRADO há ${-mins} min — ${linha}`);
      else if (mins < 5) warn(`token quase expirando — ${linha}`);
      else               ok(linha);
    }
  });

  // ── 3. PROXY DE FALHA SILENCIOSA ──────────────────────────────────────────
  await section('3. EQUIPES COM SESSÃO ABERTA E TODOS OS BUCKETS ZERADOS (hoje)', async () => {
    // No último snapshot do dia por equipe: sessão aberta (session_end null) mas
    // baixadas+executadas+concluidas+rejeitadas = 0. Suspeito de _safeNotes
    // engolindo erro da EDP (bucket vazio sem ser erro).
    const rows = await q(
      `SELECT DISTINCT ON (team_name) team_name, regional, session_end,
              baixadas, executadas, concluidas, rejeitadas,
              to_char(captured_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS hora
       FROM snapshots WHERE date = $1
       ORDER BY team_name, captured_at DESC`, [hoje]);
    const abertas   = rows.filter(r => !r.session_end);
    const zeradas   = abertas.filter(r =>
      (r.baixadas + r.executadas + r.concluidas + r.rejeitadas) === 0);
    info(`equipes no último snapshot: ${rows.length}  |  sessão aberta: ${abertas.length}`);
    if (zeradas.length === 0) ok('Nenhuma equipe aberta com todos os buckets zerados.');
    else {
      warn(`${zeradas.length} equipe(s) ABERTA(s) com 0 em tudo (verificar se é real ou coleta falha):`);
      zeradas.slice(0, 20).forEach(r => info(`${r.team_name} (${r.regional}) últ.snap ${r.hora}`));
      if (zeradas.length > 20) info(`… +${zeradas.length - 20} equipes`);
    }
  });

  // ── 4. COBERTURA DE CLASSIFICAÇÃO ─────────────────────────────────────────
  await section('4. COBERTURA DE CLASSIFICAÇÃO (% em OUTROS por tipo)', async () => {
    const rows = await q(
      `SELECT tipo, sub_code, count(*)::int AS n
       FROM note_subcategorias GROUP BY tipo, sub_code ORDER BY tipo, n DESC`);
    const porTipo = {};
    for (const r of rows) {
      porTipo[r.tipo] = porTipo[r.tipo] || { total: 0, outros: 0, sub: {} };
      porTipo[r.tipo].total += r.n;
      porTipo[r.tipo].sub[r.sub_code] = r.n;
      if (r.sub_code === 'OUTROS') porTipo[r.tipo].outros += r.n;
    }
    for (const [tipo, v] of Object.entries(porTipo)) {
      const ratio = pct(v.outros, v.total);
      const line = `${tipo}: ${v.total} notas  |  OUTROS ${v.outros} (${ratio})  |  ` +
        Object.entries(v.sub).map(([k, n]) => `${k}=${n}`).join(' ');
      if (tipo === 'DD' && v.total && v.outros / v.total > 0.5) warn(line);
      else info(line);
    }
  });

  // ── 5. INVESTIGAÇÃO DA REGRA "RAMAL BT" ───────────────────────────────────
  await section('5. REGRA "RAMAL BT" — impacto real no C93 (Subs Ramal)', async () => {
    info('Regra (classifierService:178 / notaProcessor:201): nota DD com atividade');
    info('C93 só conta como "Subs Ramal" se o Address contém "RAMAL BT".');
    info('Pergunta: a regra está derrubando ramais legítimos pra OUTROS?\n');

    // Universo: notas DD cuja classificação guardou uma atividade C93 no raw.
    // Cruza com note_details pra inspecionar o Address (endereco.logradouro).
    const rows = await q(
      `SELECT ns.sub_code,
              CASE
                WHEN nd.note_id IS NULL THEN 'sem_note_details'
                WHEN COALESCE(nd.payload->'endereco'->>'logradouro','') ILIKE '%ramal%bt%'
                     THEN 'addr_TEM_ramalbt'
                ELSE 'addr_SEM_ramalbt'
              END AS addr_flag,
              count(*)::int AS n
       FROM note_subcategorias ns
       LEFT JOIN note_details nd ON nd.note_id = ns.note_id
       WHERE ns.tipo = 'DD'
         AND ns.raw->'activities' @> '[{"Code":"C93"}]'::jsonb
       GROUP BY 1, 2 ORDER BY 1, 2`);

    if (rows.length === 0) {
      warn('Nenhuma nota DD com atividade C93 no raw — sem amostra pra avaliar a regra.');
      info('(Pode ser que raw.activities não esteja sendo populado, ou não há DD/C93 ainda.)');
      return;
    }

    const total   = rows.reduce((s, r) => s + r.n, 0);
    const comC93  = rows.filter(r => r.sub_code === 'C93').reduce((s, r) => s + r.n, 0);
    const outros  = rows.filter(r => r.sub_code === 'OUTROS').reduce((s, r) => s + r.n, 0);
    info(`Notas DD com atividade C93: ${total}`);
    info(`  → classificadas C93 (Subs Ramal): ${comC93} (${pct(comC93, total)})`);
    info(`  → jogadas em OUTROS pela regra:   ${outros} (${pct(outros, total)})`);
    console.log('');

    // Detalhe das que foram pra OUTROS: o Address realmente não tinha "RAMAL BT"?
    const outrosRows = rows.filter(r => r.sub_code === 'OUTROS');
    const semRamal  = outrosRows.find(r => r.addr_flag === 'addr_SEM_ramalbt')?.n || 0;
    const temRamal  = outrosRows.find(r => r.addr_flag === 'addr_TEM_ramalbt')?.n || 0;
    const semDet    = outrosRows.find(r => r.addr_flag === 'sem_note_details')?.n || 0;
    info('Das que foram pra OUTROS tendo atividade C93:');
    info(`  Address SEM "ramal bt"  → ${semRamal}  (regra agiu como esperado)`);
    if (temRamal > 0)
      bad(`  Address TEM "ramal bt"  → ${temRamal}  ⟵ SUSPEITO: deveriam ser C93!`);
    else
      ok(`  Address TEM "ramal bt"  → 0  (a regra não derrubou nenhum ramal com endereço certo)`);
    info(`  sem note_details (Address desconhecido) → ${semDet}  (não dá pra confirmar)`);

    if (temRamal > 0)
      bad('VEREDITO: a regra RAMAL BT está SUBNOTIFICANDO C93. Revisar antes de cravar nos testes.');
    else if (semDet > total * 0.5)
      warn('VEREDITO: amostra fraca — maioria sem note_details. Considerar backfill p/ confirmar.');
    else
      ok('VEREDITO: a regra parece consistente — OUTROS com C93 realmente não têm "ramal bt" no Address.');
  });

  // ── 6. CRONS DE AUTO-VERIFICAÇÃO ──────────────────────────────────────────
  await section('6. CRONS DE AUTO-VERIFICAÇÃO (drift / erro de classificação)', async () => {
    const keys = ['subcat_error', 'drift_last_repair'];
    const rows = await q(`SELECT key, data, updated_at FROM app_settings WHERE key = ANY($1)`, [keys]);
    if (rows.length === 0) { info('sem registros de subcat_error / drift_last_repair (ok se nunca falhou).'); return; }
    for (const r of rows) {
      const d = r.data || {};
      if (r.key === 'subcat_error') {
        if (d.message) bad(`subcat_error ATIVO: "${d.message}" @ ${d.ts}`);
        else ok(`classificação sem erro (último ok @ ${d.ts || r.updated_at})`);
      } else {
        warn(`último reparo de drift @ ${d.ts || r.updated_at}: ${JSON.stringify(d).slice(0, 200)}`);
      }
    }
  });

  // ── 7. COMPOSIÇÃO DAS DD/OUTROS ───────────────────────────────────────────
  await section('7. COMPOSIÇÃO DAS DD/OUTROS (o % alto é legítimo ou esconde ramal?)', async () => {
    const top = await q(
      `SELECT COALESCE(NULLIF(code_text,''),'(sem desc)') AS desc, count(*)::int AS n
       FROM note_subcategorias WHERE tipo='DD' AND sub_code='OUTROS'
       GROUP BY 1 ORDER BY n DESC LIMIT 15`);
    info('Top descrições (GroupDescription) entre DD/OUTROS:');
    top.forEach(r => info(`${String(r.n).padStart(5)}  ${r.desc}`));

    // Probe direto: DD/OUTROS cujo texto menciona "ramal" — possíveis ramais
    // perdidos pela via CAPEX (Activities=[] + GroupDescription).
    const ramalish = await q(
      `SELECT count(*)::int AS n,
              count(*) FILTER (
                WHERE COALESCE(nd.payload->'endereco'->>'logradouro','') ILIKE '%ramal%bt%'
              )::int AS com_ramalbt
       FROM note_subcategorias ns
       LEFT JOIN note_details nd ON nd.note_id = ns.note_id
       WHERE ns.tipo='DD' AND ns.sub_code='OUTROS' AND ns.code_text ILIKE '%ramal%'`);
    const { n, com_ramalbt } = ramalish[0];
    console.log('');
    if (n === 0) ok('Nenhuma DD/OUTROS com "ramal" na descrição — % de OUTROS é composição legítima.');
    else {
      warn(`${n} DD/OUTROS têm "ramal" na descrição.`);
      if (com_ramalbt > 0)
        bad(`  dessas, ${com_ramalbt} têm "ramal bt" no Address ⟵ deveriam ser C93 (subnotificadas).`);
      else
        ok(`  nenhuma com "ramal bt" no Address — ramal não-BT, fora do indicador por regra (ok).`);
    }
  });

  // ── 8. COMPOSIÇÃO DAS MD/OUTROS ───────────────────────────────────────────
  await section('8. COMPOSIÇÃO DAS MD/OUTROS (deveria ser tudo Code != SPEB)', async () => {
    const r0 = await q(
      `SELECT count(*) FILTER (WHERE upper(COALESCE(code,''))='SPEB')::int AS speb,
              count(*)::int AS total
       FROM note_subcategorias WHERE tipo='MD' AND sub_code='OUTROS'`);
    const { speb, total } = r0[0];
    if (speb === 0) ok(`As ${total} MD/OUTROS têm Code != SPEB — correto (só SPEB vira TL11/OBSOLETO).`);
    else bad(`${speb}/${total} MD/OUTROS têm Code=SPEB ⟵ deveriam ser TL11/OBSOLETO, não OUTROS!`);
    const top = await q(
      `SELECT COALESCE(NULLIF(code,''),'(null)') AS code, count(*)::int AS n
       FROM note_subcategorias WHERE tipo='MD' AND sub_code='OUTROS'
       GROUP BY 1 ORDER BY n DESC LIMIT 10`);
    info('Top Codes entre MD/OUTROS:');
    top.forEach(r => info(`${String(r.n).padStart(5)}  ${r.code}`));
  });

  H('FIM DA AUDITORIA');
  console.log('  Cole esta saída de volta no chat pra interpretação.\n');
}

main()
  .catch(err => { console.error('\n[diag-audit] erro fatal:', err.message); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch (_) {} });
