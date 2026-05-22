require('dotenv').config();
process.env.DATA_MODE = 'wpa';
const { getSessionsByDate } = require('./services/wpaService');
const { getClient } = require('./services/supabaseClient');

(async () => {
  const sb = getClient();
  const sessions = await getSessionsByDate('DESG', '2026-05-20');
  const fechadas = sessions.filter(s =>
    s.EndTime && s.EndTime !== '0001-01-01T00:00:00'
  );
  console.log(`Total fechadas: ${fechadas.length}`);

  // Mostra os primeiros 3 detalhes
  console.log('\n=== Amostras de sessões /all/date ===');
  fechadas.slice(0, 3).forEach((s, i) => {
    console.log(`\n[${i + 1}] Team: ${s.Team?.Name || s.Team?.ExternalReference}`);
    console.log(`    BeginTime:  "${s.BeginTime}"`);
    console.log(`    EndTime:    "${s.EndTime}"`);
    console.log(`    BeginTime2: "${s.BeginTime2}"`);
    console.log(`    EndTime2:   "${s.EndTime2}"`);
  });

  // Para a primeira equipe, busca snapshots dela e mostra o sessionBegin
  if (fechadas[0]) {
    const teamName = fechadas[0].Team?.Name;
    console.log(`\n=== Snapshots de ${teamName} no banco (últimos 5) ===`);
    const { data } = await sb.from('snapshots')
      .select('captured_at, data')
      .eq('team_name', teamName)
      .gte('date', '2026-05-20')
      .order('captured_at', { ascending: false })
      .limit(5);
    (data || []).forEach((r, i) => {
      console.log(`\n[${i + 1}] captured: ${r.captured_at}`);
      console.log(`    sessionBegin: "${r.data?.sessionBegin}"`);
      console.log(`    sessionEnd:   "${r.data?.sessionEnd || '(null)'}"`);
    });

    console.log(`\n=== Comparação ===`);
    console.log(`API BeginTime: "${fechadas[0].BeginTime}"`);
    console.log(`DB sessionBegin: "${data?.[0]?.data?.sessionBegin}"`);
    console.log(`Iguais? ${fechadas[0].BeginTime === data?.[0]?.data?.sessionBegin}`);
  }
})().catch(e => console.error(e.message));
