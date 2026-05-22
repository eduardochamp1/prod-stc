/**
 * Diagnóstico: por que o logoff não aparece quando filtra uma data histórica?
 * Pra cada equipe da regional/data dada, mostra:
 *   - todos os snapshots do dia (date=alvo)
 *   - todos os snapshots do dia seguinte que ainda tem sessionBegin da data alvo
 *   - sessionEnd em cada um — pra ver onde está o logoff
 *
 * Uso: node scripts/diag-logoff-equipe.js <equipe> <data-yyyy-mm-dd>
 * Ex:  node scripts/diag-logoff-equipe.js EBGPR63 2026-05-21
 */

require('dotenv').config();
const { getClient } = require('../services/supabaseClient');

const SIGLA = process.argv[2];
const DATA  = process.argv[3];
if (!SIGLA || !DATA) {
  console.error('Uso: node scripts/diag-logoff-equipe.js <SIGLA> <YYYY-MM-DD>');
  process.exit(1);
}

(async () => {
  const sb = getClient();

  // date+1 pra capturar snapshots da madrugada seguinte
  const dPlus1 = new Date(DATA + 'T12:00:00Z');
  dPlus1.setUTCDate(dPlus1.getUTCDate() + 1);
  const ateExpand = dPlus1.toISOString().slice(0, 10);

  const { data } = await sb.from('snapshots')
    .select('captured_at, date, data')
    .eq('team_name', SIGLA)
    .gte('date', DATA).lte('date', ateExpand)
    .order('captured_at', { ascending: true });

  if (!data?.length) { console.log('Sem snapshots'); return; }

  console.log(`Snapshots de ${SIGLA} entre ${DATA} e ${ateExpand}: ${data.length}\n`);
  console.log('captured_at                       | snap.date  | sessionBegin            | sessionEnd              | pertenceAoDia');
  console.log('-'.repeat(140));

  data.forEach(r => {
    const sb1 = r.data?.sessionBegin || r.data?.session_begin || '';
    const se1 = r.data?.sessionEnd   || r.data?.session_end   || '';
    const sbDate = String(sb1).slice(0, 10);
    const pertence = sbDate === DATA ? '✓' : '✗';
    console.log(
      `${(r.captured_at || '').padEnd(33)} | ` +
      `${(r.date || '').padEnd(10)} | ` +
      `${(sb1 || '—').padEnd(23)} | ` +
      `${(se1 || '— em campo').padEnd(23)} | ` +
      pertence
    );
  });

  // Resultado: pertencem ao dia alvo
  const pertinentes = data.filter(r => {
    const sbDate = String(r.data?.sessionBegin || '').slice(0, 10);
    return r.date === DATA || sbDate === DATA;
  });

  console.log(`\n=== Resumo ===`);
  console.log(`Snapshots filtrados (pertencentes à sessão do dia ${DATA}): ${pertinentes.length}`);
  if (pertinentes.length > 0) {
    const primeiro = pertinentes[0];
    const ultimo   = pertinentes[pertinentes.length - 1];
    console.log(`PRIMEIRO snap pertinente:`);
    console.log(`  captured_at: ${primeiro.captured_at}`);
    console.log(`  sessionBegin: ${primeiro.data.sessionBegin}`);
    console.log(`  sessionEnd:   ${primeiro.data.sessionEnd || '— em campo'}`);
    console.log(`ÚLTIMO snap pertinente:`);
    console.log(`  captured_at: ${ultimo.captured_at}`);
    console.log(`  sessionBegin: ${ultimo.data.sessionBegin}`);
    console.log(`  sessionEnd:   ${ultimo.data.sessionEnd || '— em campo'}`);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
