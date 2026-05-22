/**
 * Diagnóstico: lista TODAS as SF L0/L1 contadas em um dia/regional.
 * Mostra por equipe: número da nota, hora conclusão, Code WPA, sub_code cacheado.
 * Permite identificar visualmente notas mal classificadas ou de outras regionais.
 *
 * Uso: node scripts/diag-corte-dia.js <YYYY-MM-DD> [REGIONAL=GUA]
 * Ex:  node scripts/diag-corte-dia.js 2026-05-22 GUA
 */

require('dotenv').config();
const { getClient } = require('../services/supabaseClient');

const DATA     = process.argv[2];
const REGIONAL = (process.argv[3] || 'GUA').toUpperCase();
if (!DATA) {
  console.error('Uso: node scripts/diag-corte-dia.js <YYYY-MM-DD> [REGIONAL]');
  process.exit(1);
}

(async () => {
  const sb = getClient();

  // Pega snapshots da data (e date+1 pra cobrir sessões noturnas)
  const dPlus1 = new Date(DATA + 'T12:00:00Z');
  dPlus1.setUTCDate(dPlus1.getUTCDate() + 1);
  const ateExpand = dPlus1.toISOString().slice(0, 10);

  const { data: snaps } = await sb.from('snapshots')
    .select('team_name, regional, sector_id, data')
    .gte('date', DATA).lte('date', ateExpand)
    .eq('regional', REGIONAL);

  if (!snaps?.length) { console.log('Sem snapshots'); return; }

  // Pega notas SF únicas (por UUID) cuja equipe pertence ao dia (sessionDate = DATA)
  const sfNotes = new Map(); // noteId -> { num, team, tipo, conclusion, code, status }
  snaps.forEach(s => {
    const t = s.data;
    if (!t) return;
    const sessDate = String(t.sessionBegin || '').slice(0, 10);
    if (sessDate !== DATA) return;
    const realizadas = [...(t.notasConcluidas || []), ...(t.notasExecutadas || [])];
    realizadas.forEach(n => {
      if (n.tipoCode !== 'SF') return;
      if (!n.id || sfNotes.has(n.id)) return;
      sfNotes.set(n.id, {
        id: n.id,
        num: n.codigo,
        team: s.team_name,
        status: n.status,
        conclusionDate: n.conclusionDate,
      });
    });
  });

  const ids = [...sfNotes.keys()];
  console.log(`SF únicas em ${REGIONAL} dia ${DATA}: ${ids.length}\n`);
  if (ids.length === 0) return;

  // Cruza com note_subcategorias e note_details
  const subcatMap = {};
  const detMap = {};
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [sc, det] = await Promise.all([
      sb.from('note_subcategorias').select('note_id, sub_code, sub_categoria, code').in('note_id', chunk),
      sb.from('note_details').select('note_id, payload').in('note_id', chunk),
    ]);
    (sc.data || []).forEach(r => { subcatMap[r.note_id] = r; });
    (det.data || []).forEach(r => { detMap[r.note_id] = r; });
  }

  // Agrupa por sub_code e mostra por equipe
  const porSub = { L0: [], L1: [], OUTROS: [], SEM_CLASSIF: [] };
  ids.forEach(id => {
    const info = sfNotes.get(id);
    const sc = subcatMap[id];
    const det = detMap[id];
    const codeWPA = det?.payload?.codigo || '?';
    const subCode = sc?.sub_code || null;
    const grupo = subCode === 'L0' ? 'L0' : subCode === 'L1' ? 'L1' : subCode ? 'OUTROS' : 'SEM_CLASSIF';
    porSub[grupo].push({ ...info, code: codeWPA, sub_code: subCode || '—' });
  });

  for (const grupo of ['L0', 'L1', 'OUTROS', 'SEM_CLASSIF']) {
    const list = porSub[grupo];
    if (list.length === 0) continue;
    console.log(`\n━━━ ${grupo} (${list.length} notas) ━━━`);
    console.log('Equipe   | Número       | Status     | Code  | Conclusão');
    console.log('-'.repeat(75));
    // Ordena por equipe e depois por número
    list.sort((a, b) => a.team.localeCompare(b.team) || (a.num || '').localeCompare(b.num || ''));
    list.forEach(r => {
      const conc = (r.conclusionDate || '').replace('T', ' ').slice(0, 16);
      console.log(
        `${(r.team || '').padEnd(8)} | ${(r.num || '').padEnd(12)} | ` +
        `${(r.status || '').padEnd(10)} | ${(r.code || '').padEnd(5)} | ${conc}`
      );
    });
  }

  // Resumo por equipe
  console.log(`\n\n━━━ Resumo por EQUIPE ━━━`);
  const porEquipe = {};
  ids.forEach(id => {
    const info = sfNotes.get(id);
    const sc = subcatMap[id];
    if (!porEquipe[info.team]) porEquipe[info.team] = { L0: 0, L1: 0, OUTROS: 0, SEM: 0 };
    if (sc?.sub_code === 'L0') porEquipe[info.team].L0++;
    else if (sc?.sub_code === 'L1') porEquipe[info.team].L1++;
    else if (sc?.sub_code) porEquipe[info.team].OUTROS++;
    else porEquipe[info.team].SEM++;
  });
  console.log('Equipe   | L0 | L1 | OUTROS | SEM CLASSIF');
  console.log('-'.repeat(60));
  Object.entries(porEquipe).sort().forEach(([eq, c]) => {
    console.log(`${eq.padEnd(8)} | ${String(c.L0).padStart(2)} | ${String(c.L1).padStart(2)} | ${String(c.OUTROS).padStart(6)} | ${String(c.SEM).padStart(11)}`);
  });
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
