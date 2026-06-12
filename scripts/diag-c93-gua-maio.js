/**
 * Diagnóstico: lista TODAS as notas C93 que estão contando em GUA no mês de maio.
 * Pra cada uma, busca o Address via WPA e mostra:
 *   - Número da nota
 *   - Equipe que executou
 *   - Quantidade de ramais
 *   - Address completo
 *   - Flag "tem RAMAL BT?" sim/não
 *
 * Permite identificar visualmente se há notas inflando que o classificador
 * está deixando passar.
 *
 * Uso (no servidor Engelmig):
 *   node scripts/diag-c93-gua-maio.js
 */

require('dotenv').config();
process.env.DATA_MODE = 'wpa';

const { getClient } = require('../services/dbClient');
const { getNoteDetail } = require('../services/wpaService');

(async () => {
  const sb = getClient();

  // Pega todas as C93 que aparecem em team_daily_subcat_totals em GUA maio
  const { data: tds } = await sb.from('team_daily_subcat_totals')
    .select('date, team_name, count, quantidade')
    .eq('regional', 'GUA').eq('tipo', 'DD').eq('sub_code', 'C93')
    .gte('date', '2026-05-01').lte('date', '2026-05-21')
    .order('date');

  console.log(`Agregado team_daily_subcat_totals GUA-maio C93: ${tds.length} linhas`);
  let totalAgg = { n: 0, q: 0 };
  tds.forEach(r => { totalAgg.n += r.count; totalAgg.q += Number(r.quantidade || 0); });
  console.log(`  → ${totalAgg.n} notas, ${totalAgg.q} ramais\n`);

  // Pra cada combinação (data, equipe), busca snapshots e identifica os UUIDs das C93
  const dias = [...new Set(tds.map(r => r.date))];
  const ddUuidsPorEquipe = {};  // { 'data|team' -> Set<noteId> }

  for (const dia of dias) {
    const { data: snaps } = await sb.from('snapshots')
      .select('team_name, captured_at, data')
      .eq('date', dia)
      .eq('regional', 'GUA')
      .order('captured_at', { ascending: false });

    // Pega snapshot mais recente por equipe e extrai UUIDs DD
    const seen = new Set();
    (snaps || []).forEach(s => {
      if (seen.has(s.team_name)) return;
      seen.add(s.team_name);
      const t = s.data;
      if (!t) return;
      [...(t.notasExecutadas || []), ...(t.notasConcluidas || [])].forEach(n => {
        if (n.tipoCode === 'DD' && n.id) {
          const key = `${dia}|${s.team_name}`;
          (ddUuidsPorEquipe[key] = ddUuidsPorEquipe[key] || new Set()).add(n.id);
        }
      });
    });
  }

  // Cruza UUIDs com note_subcategorias pra filtrar só os C93
  const todosIds = [...new Set(Object.values(ddUuidsPorEquipe).flatMap(s => [...s]))];
  const c93Set = new Set();
  for (let i = 0; i < todosIds.length; i += 200) {
    const { data } = await sb.from('note_subcategorias')
      .select('note_id, sub_code, quantidade, numero')
      .in('note_id', todosIds.slice(i, i + 200))
      .eq('sub_code', 'C93');
    (data || []).forEach(r => c93Set.add(r.note_id));
  }

  // Pra cada C93, mapeia primeiro dia/equipe que aparece e busca Address via WPA
  const noteInfo = {};  // noteId -> { dia, team, ramais, address, ehRamalBT, numero }
  Object.entries(ddUuidsPorEquipe).forEach(([key, ids]) => {
    const [dia, team] = key.split('|');
    ids.forEach(id => {
      if (!c93Set.has(id)) return;
      if (!noteInfo[id]) noteInfo[id] = { dia, team, ramais: '?', address: '', ehRamalBT: null };
    });
  });

  const noteIds = Object.keys(noteInfo);
  console.log(`UUIDs únicos de notas C93 em GUA maio: ${noteIds.length}\n`);

  // Busca classificação (pra pegar quantidade) e Address via WPA
  for (let i = 0; i < noteIds.length; i += 200) {
    const { data } = await sb.from('note_subcategorias')
      .select('note_id, quantidade, numero')
      .in('note_id', noteIds.slice(i, i + 200));
    (data || []).forEach(r => {
      if (noteInfo[r.note_id]) {
        noteInfo[r.note_id].ramais = r.quantidade ?? '?';
        noteInfo[r.note_id].numero = r.numero;
      }
    });
  }

  console.log('Buscando Address de cada nota via WPA (pode demorar)...\n');
  console.log('Data       | Equipe   | Numero        | qtd | RAMAL BT? | Address');
  console.log('-'.repeat(140));

  let comBT = 0, semBT = 0;
  let qtdComBT = 0, qtdSemBT = 0;
  for (let i = 0; i < noteIds.length; i += 4) {
    const chunk = noteIds.slice(i, i + 4);
    await Promise.all(chunk.map(async id => {
      try {
        const d = await getNoteDetail(id, 'DESG');
        const info = noteInfo[id];
        const addr = d?.Address || '';
        const ehBT = /ramal\s+bt/i.test(addr);
        info.address = addr;
        info.ehRamalBT = ehBT;
        const flag = ehBT ? '✓ SIM' : '✗ NÃO';
        const qtdNum = Number(info.ramais) || 0;
        if (ehBT) { comBT++; qtdComBT += qtdNum; } else { semBT++; qtdSemBT += qtdNum; }
        console.log(`${info.dia} | ${(info.team || '').padEnd(8)} | ${(info.numero || '').padEnd(13)} | ${String(info.ramais).padStart(3)} | ${flag.padEnd(8)} | ${addr.slice(0, 60)}`);
      } catch (e) {
        console.log(`${noteInfo[id].dia} | ${(noteInfo[id].team || '').padEnd(8)} | ${(noteInfo[id].numero || id).padEnd(13)} | ${String(noteInfo[id].ramais).padStart(3)} | ERRO     | ${e.message}`);
      }
    }));
  }

  console.log('\n=== RESUMO ===');
  console.log(`Com "Ramal BT" no Address: ${comBT} notas, ${qtdComBT} ramais  ✓ corretas`);
  console.log(`SEM "Ramal BT" no Address: ${semBT} notas, ${qtdSemBT} ramais  ${semBT > 0 ? '✗ INFLANDO' : '✓'}`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
