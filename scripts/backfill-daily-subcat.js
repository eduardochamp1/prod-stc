/**
 * scripts/backfill-daily-subcat.js
 *
 * Agrega histórico diário por subcategoria a partir de:
 *   1. snapshots (notasConcluidas[] e variações de cada equipe a cada 15 min)
 *   2. note_subcategorias (sub_code de cada UUID já classificado)
 *
 * Popula 2 tabelas:
 *   - daily_subcat_totals      (date × regional × tipo × sub_code)
 *   - team_daily_subcat_totals (date × equipe × regional × tipo × sub_code)
 *
 * Idempotente — usa upsert por chave única, pode rodar várias vezes.
 *
 * Lógica de "executou em data X":
 *   - Pra cada nota dentro de notasConcluidas[]: usa conclusionDate (yyyy-mm-dd
 *     ou dd/mm/yyyy) → vira a date efetiva (não date do snapshot).
 *   - Pra notasExecutadas[] / notasBaixadas[] / notasRejeitadas[] / notasVistoriadas[]:
 *     usa date do snapshot (são fluxos intraday).
 *   - Dedupe por (date, team_name, tipo, sub_code, note_id) — uma mesma nota
 *     que aparece em vários snapshots do mesmo dia conta UMA vez.
 *
 * Uso:
 *   node scripts/backfill-daily-subcat.js                       # tudo
 *   node scripts/backfill-daily-subcat.js 2026-04-01            # de uma data
 *   node scripts/backfill-daily-subcat.js 2026-04-01 2026-04-30 # intervalo
 */

require('dotenv').config();

const { getClient } = require('../services/dbClient');

const argDe  = process.argv[2] || null;
const argAte = process.argv[3] || null;

const TIPOS_DESDOBRADOS = new Set(['MD', 'SF', 'DD']);

// Data de sessão (BRT) da equipe — regra de negócio: produção da equipe
// pertence ao dia em que a sessão começou (sessionBegin), independente do
// conclusionDate de cada nota.
function _sessionDate(team) {
  if (!team || !team.sessionBegin) return null;
  const sb = String(team.sessionBegin);
  if (/^\d{4}-\d{2}-\d{2}/.test(sb)) return sb.slice(0, 10);
  return null;
}

async function fetchSnapshotsRange(de, ate) {
  const sb = getClient();
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    // captured_at é CRÍTICO — usado em indexSnapshots pra escolher o snapshot
    // MAIS RECENTE de cada (team, sessionBegin). Sem ele, comparações viram
    // undefined > undefined = false, e o Map mantém o primeiro snapshot
    // encontrado (que pode ser velho e com poucas notas concluídas).
    let q = sb.from('snapshots')
      .select('date, sector_id, regional, team_name, captured_at, data')
      .order('captured_at', { ascending: false }); // mais recente primeiro
    if (de)  q = q.gte('date', de);
    if (ate) q = q.lte('date', ate);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchSubcatMap(noteIds) {
  if (noteIds.length === 0) return {};
  const sb = getClient();
  const wanted = new Set(noteIds);
  const out = {};

  // Pagina toda a tabela e filtra em memória — evita .in() com URL gigante
  // (que pode dar "TypeError: fetch failed" em chunks grandes / redes flutuantes).
  // Com 2752 rows e PAGE=1000, são ~3 requests rápidos.
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from('note_subcategorias')
      .select('note_id, tipo, sub_code, quantidade')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    data.forEach(r => {
      if (wanted.has(r.note_id)) out[r.note_id] = r;
    });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Constrói registros agregados em memória.
 * Saída:
 *   regional: Map<key, { date, regional, tipo, sub_code, count, quantidade, noteIds:Set }>
 *   team:     Map<key, { date, team_name, regional, sector_id, tipo, sub_code, count, quantidade, noteIds:Set }>
 *   noteIds:  Set<string> de todos UUIDs únicos (pra fetch em note_subcategorias)
 */
function indexSnapshots(snapshots) {
  const noteIds = new Set();
  const events = []; // { date, team, regional, sector, tipo, noteId }

  // REGRA DE NEGÓCIO: a "data efetiva" de uma nota é o sessionBegin da equipe
  // que a executou, não o conclusionDate da nota. Equipe que loga em D e
  // encerra em D+1 madrugada → tudo conta em D.
  // Pra cada (team, sessionBegin), pegamos o snapshot MAIS RECENTE (último estado
  // da sessão) — assim não duplicamos contagem por aparecer em múltiplos snapshots.
  const latestBySession = new Map(); // key: `${team}|${sessionBegin}` → snapshot

  // Snapshots vêm ordenados por captured_at DESC do fetchSnapshotsRange,
  // então o primeiro snapshot de cada (team, sessionBegin) que encontrarmos
  // já é o mais recente. Comparação explícita não necessária.
  snapshots.forEach(snap => {
    const t = snap.data;
    if (!t) return;
    const team   = snap.team_name || t.teamName;
    const reg    = snap.regional  || t.regional;
    const sector = snap.sector_id || t.sectorId;
    if (!team || !reg || !sector) return;
    const sessDate = _sessionDate(t);
    if (!sessDate) return;

    const key = `${team}|${t.sessionBegin}`;
    if (!latestBySession.has(key)) {
      latestBySession.set(key, { snap, team, reg, sector, sessDate });
    }
  });

  // Agora constrói events a partir do snapshot final de cada sessão.
  // Notas executadas + concluídas — TODAS contam pra sessDate (sem filtro por
  // conclusionDate, pois a regra é por sessão).
  latestBySession.forEach(({ snap, team, reg, sector, sessDate }) => {
    const t = snap.data;
    [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])].forEach(n => {
      if (!n.id) return;
      const tipo = (n.tipoCode || '').toUpperCase();
      if (!TIPOS_DESDOBRADOS.has(tipo)) return;
      events.push({ date: sessDate, team, regional: reg, sector, tipo, noteId: n.id });
      noteIds.add(n.id);
    });
  });

  return { events, noteIds: [...noteIds] };
}

function aggregate(events, subcatMap) {
  // Dedupe por (date, team, tipo, noteId) — mesma nota em vários snapshots do dia conta 1
  const seen = new Set();
  const uniqEvents = [];
  events.forEach(e => {
    const k = `${e.date}|${e.team}|${e.tipo}|${e.noteId}`;
    if (seen.has(k)) return;
    seen.add(k);
    uniqEvents.push(e);
  });

  // Acumula: por equipe e por regional
  const byTeam     = new Map();   // key: date|team|tipo|sub_code
  const byRegional = new Map();   // key: date|regional|tipo|sub_code

  uniqEvents.forEach(e => {
    const sc = subcatMap[e.noteId];
    const sub_code   = sc?.sub_code   || 'OUTROS';
    const quantidade = sc?.quantidade != null ? Number(sc.quantidade) : null;

    const tk = `${e.date}|${e.team}|${e.tipo}|${sub_code}`;
    if (!byTeam.has(tk)) {
      byTeam.set(tk, {
        date: e.date, team_name: e.team, regional: e.regional, sector_id: e.sector,
        tipo: e.tipo, sub_code, count: 0, quantidade: null,
      });
    }
    const t = byTeam.get(tk);
    t.count += 1;
    if (quantidade != null) t.quantidade = (t.quantidade ?? 0) + quantidade;

    const rk = `${e.date}|${e.regional}|${e.tipo}|${sub_code}`;
    if (!byRegional.has(rk)) {
      byRegional.set(rk, {
        date: e.date, regional: e.regional, tipo: e.tipo, sub_code,
        count: 0, quantidade: null,
      });
    }
    const r = byRegional.get(rk);
    r.count += 1;
    if (quantidade != null) r.quantidade = (r.quantidade ?? 0) + quantidade;
  });

  return {
    teamRows:     [...byTeam.values()],
    regionalRows: [...byRegional.values()],
  };
}

async function upsertChunked(table, rows, conflictCols) {
  if (rows.length === 0) return 0;
  const sb = getClient();
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map(r => ({ ...r, updated_at: new Date().toISOString() }));
    const { error } = await sb.from(table).upsert(chunk, { onConflict: conflictCols });
    if (error) throw error;
    total += chunk.length;
  }
  return total;
}

async function _trabalho() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Backfill diário por subcategoria — daily_subcat_totals');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Período: ${argDe || '(início)'} → ${argAte || '(hoje)'}`);

  const t0 = Date.now();

  console.log('\n[1/4] Carregando snapshots...');
  const snaps = await fetchSnapshotsRange(argDe, argAte);
  console.log(`      ${snaps.length} snapshots no período`);

  console.log('\n[2/4] Indexando notas e coletando UUIDs...');
  const { events, noteIds } = indexSnapshots(snaps);
  console.log(`      ${events.length} eventos brutos; ${noteIds.length} UUIDs únicos`);

  console.log('\n[3/4] Buscando classificações em note_subcategorias...');
  const subcatMap = await fetchSubcatMap(noteIds);
  const classified = Object.keys(subcatMap).length;
  const pctCob = noteIds.length > 0 ? ((classified / noteIds.length) * 100).toFixed(1) : '0';
  console.log(`      ${classified}/${noteIds.length} (${pctCob}%) UUIDs classificados`);
  console.log(`      ${noteIds.length - classified} caem em OUTROS (não classificadas)`);

  console.log('\n[4/4] Agregando + upsertando...');
  const { teamRows, regionalRows } = aggregate(events, subcatMap);
  console.log(`      ${regionalRows.length} linhas por regional`);
  console.log(`      ${teamRows.length} linhas por equipe`);

  const savedReg  = await upsertChunked('daily_subcat_totals',      regionalRows, 'date,regional,tipo,sub_code');
  const savedTeam = await upsertChunked('team_daily_subcat_totals', teamRows,     'date,team_name,tipo,sub_code');

  const totalSec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n✅ Backfill concluído em ${totalSec}s`);
  console.log(`   daily_subcat_totals:      ${savedReg} linhas gravadas`);
  console.log(`   team_daily_subcat_totals: ${savedTeam} linhas gravadas`);

  // Sumário de distribuição
  console.log('\n📊 Distribuição agregada (regional):');
  const distSubcode = {};
  regionalRows.forEach(r => {
    const k = `${r.tipo}/${r.sub_code}`;
    distSubcode[k] = (distSubcode[k] || 0) + r.count;
  });
  Object.entries(distSubcode).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    console.log(`   ${k.padEnd(15)} ${v}`);
  });

  process.exit(0);
}


// 28/08/2026 — P2-43. Este script escreve em tabela de onde saem os números
// reportados à EDP, e não tinha NENHUMA guarda contra duas cópias em paralelo.
// O incidente de 09/07/2026 (P0-0) foi ~60 processos node concorrentes
// derrubando o Postgres por OOM; a lição virou advisory lock, mas só no
// backfill-consolidate.js. Agora é compartilhado — ver scripts/_lock.js.
const { comLock } = require('./_lock');
async function main() {
  return comLock('backfill-daily-subcat', { force: process.argv.includes('--force') }, _trabalho);
}
main().catch(err => {
  console.error('\n❌ ERRO:', err.message);
  console.error(err.stack);
  process.exit(1);
});
