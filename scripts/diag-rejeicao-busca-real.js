/**
 * Varre N notas rejeitadas dos snapshots, chama o endpoint do tipo correspondente
 * (/api/notes/{md|sf|dd}?noteId=...) e mostra as que TÊM HistoryRejections/Rejection
 * populados. Confirma onde fica o motivo real da rejeição.
 *
 * Uso: node scripts/diag-rejeicao-busca-real.js [LIMITE=50]
 */

require('dotenv').config();
const { getClient } = require('../services/supabaseClient');
const { wpaFetch } = require('../services/wpaService');

const LIMITE = parseInt(process.argv[2] || '50', 10);

// Mapa tipo → endpoint (existem variantes: md, sfdl, sfrl, dd, etc)
const ENDPOINTS_POR_TIPO = {
  MD: '/api/notes/md',
  SF: '/api/notes/sfrl',  // SF remoto (mais comum); fallback SFDL pode ser feito se falhar
  DD: '/api/notes/dd',
  LN: '/api/notes/ln',
  LE: '/api/notes/le',
  DL: '/api/notes/dl',
  RL: '/api/notes/rl',
};

(async () => {
  const sb = getClient();

  // Pega notas rejeitadas distintas dos snapshots recentes
  const { data: rows } = await sb.from('snapshots')
    .select('team_name, sector_id, date, data')
    .gte('date', '2026-05-01')
    .order('date', { ascending: false })
    .limit(200);

  const candidatos = [];
  const seen = new Set();
  (rows || []).forEach(r => {
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

  console.log(`Notas candidatas (status=rejeitada nos snapshots): ${candidatos.length}`);
  if (candidatos.length === 0) return;

  const amostra = candidatos.slice(0, LIMITE);
  console.log(`Testando as primeiras ${amostra.length}...\n`);

  let comRejeicao = 0;
  let semRejeicao = 0;
  const exemploComRejeicao = [];

  for (const c of amostra) {
    const endpoint = ENDPOINTS_POR_TIPO[c.tipo];
    if (!endpoint) continue;
    try {
      const r = await wpaFetch(`${endpoint}?noteId=${c.id}`);
      if (!r.ok) continue;
      const d = (await r.json())?.Data || {};
      const hr = d.HistoryRejections || [];
      const rej = d.Rejection || null;
      const temDados = (Array.isArray(hr) && hr.length > 0) || (rej && Object.keys(rej).length > 0);
      if (temDados) {
        comRejeicao++;
        if (exemploComRejeicao.length < 5) {
          exemploComRejeicao.push({ ...c, HistoryRejections: hr, Rejection: rej });
        }
      } else {
        semRejeicao++;
      }
    } catch (err) {
      // segue
    }
  }

  console.log(`Testadas: ${amostra.length}`);
  console.log(`Com HistoryRejections ou Rejection populado: ${comRejeicao}`);
  console.log(`Sem dados de rejeição:                       ${semRejeicao}\n`);

  if (exemploComRejeicao.length === 0) {
    console.log('⚠ Nenhuma das ' + amostra.length + ' rejeitadas testadas tem HistoryRejections preenchido.');
    console.log('  Pode ser que: (a) o WPA não expõe o motivo via API mobile,');
    console.log('  (b) precise de outro endpoint, ou');
    console.log('  (c) só fica disponível pra um tipo específico de rejeição.');
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('AMOSTRAS COM REJEIÇÃO POPULADA');
  console.log('═══════════════════════════════════════════════════════════════');
  exemploComRejeicao.forEach((ex, i) => {
    console.log(`\n[${i + 1}] ${ex.tipo} | ${ex.codigo} | ${ex.team} | ${ex.date} | UUID=${ex.id}`);
    if (ex.HistoryRejections?.length > 0) {
      console.log('  HistoryRejections (' + ex.HistoryRejections.length + '):');
      ex.HistoryRejections.forEach((h, j) => {
        console.log(`    [${j + 1}] ${JSON.stringify(h, null, 2).slice(0, 500)}`);
      });
    }
    if (ex.Rejection) {
      console.log('  Rejection: ' + JSON.stringify(ex.Rejection, null, 2).slice(0, 500));
    }
  });
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
