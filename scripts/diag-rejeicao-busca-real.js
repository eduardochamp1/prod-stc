/**
 * Varre snapshots PAGINADO, coleta TODAS as notas rejeitadas únicas e testa
 * /api/notes/{tipo}?noteId=... pra ver onde fica o motivo.
 *
 * Uso: node scripts/diag-rejeicao-busca-real.js [AMOSTRA=50]
 */

require('dotenv').config();
const { getClient } = require('../services/dbClient');
const { wpaFetch } = require('../services/wpaService');

const AMOSTRA = parseInt(process.argv[2] || '50', 10);

const ENDPOINTS_POR_TIPO = {
  MD: '/api/notes/md',
  SF: '/api/notes/sfrl',
  DD: '/api/notes/dd',
  LN: '/api/notes/ln',
  LE: '/api/notes/le',
  DL: '/api/notes/dl',
  RL: '/api/notes/rl',
};

(async () => {
  const sb = getClient();

  // Pagina snapshots dos últimos 30 dias
  const candidatos = [];
  const seen = new Set();
  let page = 0;
  let totalSnaps = 0;
  while (true) {
    const { data, error } = await sb.from('snapshots')
      .select('team_name, sector_id, date, data')
      .gte('date', '2026-04-23')
      .order('captured_at', { ascending: false })
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error || !data || data.length === 0) break;
    totalSnaps += data.length;
    data.forEach(r => {
      (r.data?.notasRejeitadas || []).forEach(n => {
        if (n.id && !seen.has(n.id)) {
          seen.add(n.id);
          candidatos.push({
            id: n.id,
            codigo: n.codigo,
            tipo: n.tipoCode,
            team: r.team_name,
            sector: r.sector_id,
            date: r.date,
          });
        }
      });
    });
    if (data.length < 1000) break;
    page++;
    if (page > 100) break; // safety
  }

  console.log(`Snapshots varridos: ${totalSnaps}`);
  console.log(`Notas rejeitadas únicas encontradas: ${candidatos.length}`);
  if (candidatos.length === 0) {
    console.log('\n⚠ Nenhuma rejeitada nos snapshots. Possíveis razões:');
    console.log('  - O _acc não está propagando rejeitadas (vimos isso antes — bug do _ghostFromAcc)');
    console.log('  - O snapshot só captura sessão ativa e rejeitadas saem rápido do payload');
    console.log('  - O período não tem rejeições reais');
    return;
  }

  // Distribuição por tipo
  const porTipo = {};
  candidatos.forEach(c => { porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1; });
  console.log('\nDistribuição por tipo:');
  Object.entries(porTipo).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${t}: ${n}`));

  // Amostra de cada tipo principal pra testar endpoints
  const amostraPorTipo = {};
  candidatos.forEach(c => {
    if (!amostraPorTipo[c.tipo]) amostraPorTipo[c.tipo] = [];
    if (amostraPorTipo[c.tipo].length < Math.ceil(AMOSTRA / 5)) amostraPorTipo[c.tipo].push(c);
  });

  const amostra = Object.values(amostraPorTipo).flat().slice(0, AMOSTRA);
  console.log(`\nTestando ${amostra.length} amostras (variadas por tipo)...\n`);

  const comDados = [];
  const semDados = [];

  for (const c of amostra) {
    const endpoint = ENDPOINTS_POR_TIPO[c.tipo];
    if (!endpoint) continue;
    try {
      const r = await wpaFetch(`${endpoint}?noteId=${c.id}`);
      if (!r.ok) {
        semDados.push({ ...c, motivo: `HTTP ${r.status}` });
        continue;
      }
      const d = (await r.json())?.Data || {};
      const hr = d.HistoryRejections || [];
      const rej = d.Rejection || null;
      if ((Array.isArray(hr) && hr.length > 0) || (rej && Object.keys(rej || {}).length > 0)) {
        comDados.push({ ...c, HistoryRejections: hr, Rejection: rej });
      } else {
        semDados.push({ ...c, motivo: 'campos vazios' });
      }
    } catch (err) {
      semDados.push({ ...c, motivo: err.message });
    }
  }

  console.log(`Com HistoryRejections/Rejection populado: ${comDados.length}`);
  console.log(`Sem dados:                                 ${semDados.length}\n`);

  if (comDados.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('AMOSTRAS COM DADOS DE REJEIÇÃO POPULADOS');
    console.log('═══════════════════════════════════════════════════════════════');
    comDados.slice(0, 5).forEach((ex, i) => {
      console.log(`\n[${i + 1}] ${ex.tipo} | ${ex.codigo} | ${ex.team} | ${ex.date}`);
      console.log(`    UUID: ${ex.id}`);
      if (ex.HistoryRejections?.length > 0) {
        console.log('    HistoryRejections (' + ex.HistoryRejections.length + '):');
        ex.HistoryRejections.forEach((h, j) => {
          console.log(`      [${j + 1}] keys: ${Object.keys(h).join(', ')}`);
          console.log(`           ${JSON.stringify(h, null, 2).slice(0, 800)}`);
        });
      }
      if (ex.Rejection && Object.keys(ex.Rejection).length) {
        console.log('    Rejection: ' + JSON.stringify(ex.Rejection, null, 2).slice(0, 800));
      }
    });
  } else {
    console.log('⚠ NINGUÉM TEM HistoryRejections populado.');
    console.log('   Significa que as "rejeitadas" do nosso banco são na verdade notas CONCLUÍDAS com ConclusionStatus específico (provavelmente bandeiradas), não devoluções com motivo.');
    console.log('\nExemplos de "sem dados":');
    semDados.slice(0, 5).forEach(s => console.log(`  ${s.tipo} ${s.codigo} ${s.team} ${s.date} — ${s.motivo}`));
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
