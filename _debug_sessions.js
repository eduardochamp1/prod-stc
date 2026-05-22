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

  console.log(`Total fechadas DESG dia 20/05: ${fechadas.length}\n`);

  // Pra cada equipe, busca snapshot e mostra se sessionBegin bate
  let bate = 0, naoBate = 0, semSnap = 0;
  for (const s of fechadas) {
    const teamName = s.Team?.Name || s.Team?.ExternalReference;
    const beginTime = s.BeginTime;
    const endTime = s.EndTime;

    const { data: rows } = await sb.from('snapshots')
      .select('captured_at, data')
      .eq('team_name', teamName)
      .gte('date', '2026-05-20').lte('date', '2026-05-21')
      .order('captured_at', { ascending: true });

    const snapBate = (rows || []).find(r => {
      const sb1 = r.data?.sessionBegin || r.data?.session_begin;
      return sb1 === beginTime;
    });

    if (!rows || rows.length === 0) {
      semSnap++;
      console.log(`[SEM SNAP] ${teamName} | begin=${beginTime} end=${endTime}`);
    } else if (snapBate) {
      bate++;
    } else {
      naoBate++;
      const todosSb = [...new Set((rows || []).map(r => r.data?.sessionBegin))];
      console.log(`[NÃO BATE] ${teamName} | API begin=${beginTime}`);
      console.log(`           sessionBegins no DB: ${todosSb.join(', ')}`);
    }
  }
  console.log(`\n=== RESUMO ===`);
  console.log(`Sessões fechadas: ${fechadas.length}`);
  console.log(`Bate com snap:    ${bate}`);
  console.log(`Não bate:         ${naoBate}`);
  console.log(`Equipe sem snap:  ${semSnap}`);
})().catch(e => console.error(e.message));
