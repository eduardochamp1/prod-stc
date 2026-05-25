#!/usr/bin/env node
/**
 * scripts/backfill-rejections.js
 *
 * Popula a tabela note_rejections com o histórico de rejeições.
 *
 * Estratégia:
 *   1. Varre snapshots e coleta TODOS os note_id rejeitados únicos por equipe/dia.
 *      Pra cada (note_id, team_name): pega o snapshot MAIS ANTIGO (perto do
 *      sessionBegin), pois nele estão os colaboradores corretos da sessão que
 *      atendeu a nota.
 *   2. Filtra os que já estão em note_rejections (idempotente).
 *   3. Pra cada novo, chama rejectionService.fetchRejectionDetails(noteId, tipo)
 *      pra pegar motivos/observação/data — políticas:
 *      • Se retornar 200 com detalhes: grava tudo.
 *      • Se retornar 500 ou endpoint desconhecido: grava mesmo assim com
 *        motivo_codes=[] (contagem da rejeição vale, sem categorização).
 *   4. Insere em batches.
 *
 * Política colaboradores (B(a) da área de negócio):
 *   Todos os colaboradores logados na sessão recebem 1 ponto cada por rejeição
 *   (sem divisão). Por isso guardamos arrays codes+names — agregação faz unnest.
 *
 * Uso:
 *   node scripts/backfill-rejections.js                       # tudo (snapshot mais antigo até hoje)
 *   node scripts/backfill-rejections.js 2026-05-01            # de 2026-05-01 até hoje
 *   node scripts/backfill-rejections.js 2026-05-01 2026-05-25 # intervalo fechado
 *   node scripts/backfill-rejections.js --dry-run             # só lista, não grava
 *   node scripts/backfill-rejections.js --limit=50            # processa só 50 (teste)
 */

require('dotenv').config();
const { getClient } = require('../services/supabaseClient');
const { login: wpaLogin } = require('../services/wpaService');
const { fetchRejectionDetails, getDiscoveredPaths } = require('../services/rejectionService');
const { getKnownRejectedIds, upsertRejections } = require('../db/rejectionsQueries');

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const argDe  = positional[0] || null;
const argAte = positional[1] || null;
const DRY_RUN = args.includes('--dry-run');
const LIMIT   = parseInt((args.find(a => a.startsWith('--limit=')) || '').slice('--limit='.length), 10) || null;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchSnapshotsRange(de, ate) {
  const sb = getClient();
  let q = sb
    .from('snapshots')
    .select('team_name, regional, sector_id, date, captured_at, data')
    .order('captured_at', { ascending: true });   // ASC pra pegar o mais antigo primeiro
  if (de)  q = q.gte('date', de);
  if (ate) q = q.lte('date', ate);

  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/**
 * Coleta candidatos únicos por note_id. Pra cada note_id mantém o snapshot
 * mais antigo (ASC), assumindo que esse tem os colaboradores da sessão original.
 */
function coletarCandidatos(snapshots) {
  const byNoteId = new Map();   // note_id → candidato
  for (const snap of snapshots) {
    const d = snap.data;
    if (!d) continue;
    const rej = d.notasRejeitadas || [];
    if (rej.length === 0) continue;

    // Colaboradores da sessão (estrutura: array de { code, name } ou similar)
    const collabs = (d.collaborators || []).map(c => ({
      code: String(c?.code || c?.Code || c?.matricula || '').trim(),
      name: String(c?.name || c?.Name || '').trim(),
    })).filter(c => c.code);

    const collaborator_codes = collabs.map(c => c.code);
    const collaborator_names = collabs.map(c => c.name);

    // sessionDate: usa snapshot.date (já é session-date-attributed pelo cron)
    const session_date = snap.date;

    for (const n of rej) {
      const id   = n?.id || n?.Id;
      const tipo = String(n?.tipoCode || n?.Type || n?.tipo || '').toUpperCase();
      const numero = String(n?.codigo || n?.code || n?.Number || '').trim() || null;
      if (!id || !tipo) continue;

      if (byNoteId.has(id)) continue;  // mantém o mais antigo (ASC)
      byNoteId.set(id, {
        note_id:   id,
        numero,
        tipo,
        team_name: snap.team_name,
        regional:  snap.regional,
        sector_id: snap.sector_id || null,
        session_date,
        collaborator_codes,
        collaborator_names,
      });
    }
  }
  return Array.from(byNoteId.values());
}

async function processBatch(candidates, batchSize = 5) {
  const rows = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const chunk = candidates.slice(i, i + batchSize);
    const results = await Promise.all(chunk.map(async c => {
      try {
        const det = await fetchRejectionDetails(c.note_id, c.tipo);
        return { c, det };
      } catch (err) {
        return { c, det: null, error: err.message };
      }
    }));
    for (const { c, det, error } of results) {
      if (error) {
        console.warn(`   ⚠️  ${c.note_id.slice(0, 8)} ${c.tipo}: ${error}`);
      }
      // Mesmo se det for null/sem detalhes, gravamos a rejeição (com motivos vazios).
      const row = {
        note_id:        c.note_id,
        numero:         c.numero,
        tipo:           c.tipo,
        team_name:      c.team_name,
        regional:       c.regional,
        sector_id:      c.sector_id,
        rejection_date: det?.rejection_date || null,
        session_date:   c.session_date,
        observacao:     det?.observacao || null,
        motivo_codes:   det?.motivo_codes  || [],
        motivo_textos:  det?.motivo_textos || [],
        formulario:     det?.formulario || null,
        collaborator_codes: c.collaborator_codes,
        collaborator_names: c.collaborator_names,
        raw:            det?.raw || (error ? { error } : { no_detail: true }),
      };
      rows.push(row);
    }
  }
  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Backfill de Rejeições — Engelmig WPA Monitor');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Período: ${argDe || '(início)'} → ${argAte || '(hoje)'}`);
  if (DRY_RUN) console.log(`Modo:    DRY-RUN (não grava no banco)`);
  if (LIMIT)   console.log(`Limite:  ${LIMIT} notas (debug)`);

  const t0 = Date.now();

  // Login WPA upfront (evita 1 chamada paralela perder o token)
  console.log('\n[1/5] Autenticando WPA...');
  await wpaLogin();
  console.log('      ✅ login OK');

  console.log('\n[2/5] Carregando snapshots...');
  const snaps = await fetchSnapshotsRange(argDe, argAte);
  console.log(`      ${snaps.length} snapshots no período`);

  console.log('\n[3/5] Coletando candidatos únicos (1 entrada por note_id)...');
  let candidatos = coletarCandidatos(snaps);
  console.log(`      ${candidatos.length} note_ids rejeitados únicos`);

  if (candidatos.length === 0) {
    console.log('\n✅ Nada a fazer.');
    process.exit(0);
  }

  console.log('\n[4/5] Filtrando já gravados em note_rejections...');
  const known = await getKnownRejectedIds();
  const todo  = candidatos.filter(c => !known.has(c.note_id));
  console.log(`      ${todo.length} a processar (${candidatos.length - todo.length} já cacheados)`);

  if (LIMIT && todo.length > LIMIT) {
    console.log(`      ✂  --limit=${LIMIT}: cortando pra ${LIMIT}`);
    todo.length = LIMIT;
  }

  if (todo.length === 0) {
    console.log('\n✅ Tudo já está em note_rejections.');
    process.exit(0);
  }

  // Distribuição por tipo (estima tempo)
  const dist = todo.reduce((acc, c) => { acc[c.tipo] = (acc[c.tipo] || 0) + 1; return acc; }, {});
  console.log(`      Distribuição: ${Object.entries(dist).map(([t, n]) => `${t}=${n}`).join('  ')}`);
  console.log(`      Estimativa: ~${Math.ceil(todo.length * 0.3)}s (5 paralelas, ~300ms cada)`);

  console.log('\n[5/5] Buscando detalhes na WPA + gravando...');
  const CHUNK = 100;  // grava a cada 100 pra resiliência
  let processed = 0;
  let saved     = 0;
  let semDetalhe = 0;

  for (let i = 0; i < todo.length; i += CHUNK) {
    const batch = todo.slice(i, i + CHUNK);
    const tBatch = Date.now();
    const rows = await processBatch(batch, 5);

    semDetalhe += rows.filter(r => r.motivo_codes.length === 0).length;

    if (!DRY_RUN && rows.length > 0) {
      const n = await upsertRejections(rows);
      saved += n;
    }
    processed += batch.length;
    const pct = ((processed / todo.length) * 100).toFixed(1);
    const dt  = ((Date.now() - tBatch) / 1000).toFixed(1);
    console.log(`      ${processed}/${todo.length} (${pct}%) — lote em ${dt}s — saved=${saved}  sem_detalhe=${semDetalhe}`);
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n✅ Backfill concluído em ${totalSec}s`);
  console.log(`   gravadas: ${saved}`);
  console.log(`   sem detalhe (motivos vazios): ${semDetalhe}`);

  console.log('\nEndpoints descobertos durante o run:');
  console.log('  ' + JSON.stringify(getDiscoveredPaths(), null, 2).replace(/\n/g, '\n  '));

  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ ERRO:', err.message);
  console.error(err.stack);
  process.exit(1);
});
