/**
 * Diagnóstico de uma nota específica — mostra TUDO sobre ela:
 *   - estado em note_subcategorias (classificação atual)
 *   - estado em note_details (cache local)
 *   - payload bruto da WPA (chamada ao vivo)
 *   - Address, Type, Code, Activities[]
 *   - em quais snapshots aparece (data, equipe, status)
 *   - se está sendo contada em team_daily_subcat_totals
 *
 * Uso: node scripts/diag-nota-especifica.js <numero-ou-uuid>
 * Ex:  node scripts/diag-nota-especifica.js 000017172048
 */

require('dotenv').config();
process.env.DATA_MODE = 'wpa';

const { getClient } = require('../services/supabaseClient');
const { getNoteDetail } = require('../services/wpaService');
const { classificar } = require('../services/classifierService');

const ARG = process.argv[2];
if (!ARG) { console.error('Uso: node scripts/diag-nota-especifica.js <numero-ou-uuid>'); process.exit(1); }

(async () => {
  const sb = getClient();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(ARG);

  // 1) Acha UUID a partir do número (ou usa direto se já é UUID)
  let noteId, numero;
  if (isUuid) {
    noteId = ARG;
    const { data } = await sb.from('note_subcategorias').select('numero').eq('note_id', noteId).limit(1);
    numero = data?.[0]?.numero;
  } else {
    numero = ARG;
    // Tenta achar UUID via note_subcategorias
    const { data: ns } = await sb.from('note_subcategorias').select('note_id').eq('numero', numero).limit(1);
    if (ns?.[0]) noteId = ns[0].note_id;
    if (!noteId) {
      // Tenta via note_details
      const { data: nd } = await sb.from('note_details').select('note_id').eq('numero', numero).limit(1);
      if (nd?.[0]) noteId = nd[0].note_id;
    }
    if (!noteId) {
      // Tenta via snapshots (raro mas possível)
      console.log('Nota não encontrada em cache. Procurando em snapshots...');
      const { data: snaps } = await sb.from('snapshots').select('data').limit(5000);
      for (const r of (snaps || [])) {
        const t = r.data;
        if (!t) continue;
        const all = [...(t.notasExecutadas || []), ...(t.notasConcluidas || []), ...(t.notasRejeitadas || []), ...(t.notasBaixadas || [])];
        const found = all.find(n => (n.codigo || '').replace(/^0+/, '') === numero.replace(/^0+/, ''));
        if (found) { noteId = found.id; break; }
      }
    }
  }

  if (!noteId) { console.error(`Nota ${ARG} não encontrada em lugar nenhum.`); process.exit(1); }

  console.log(`\n=== Nota ${numero || '(num desconhecido)'} | UUID: ${noteId} ===\n`);

  // 2) Estado em note_subcategorias
  const { data: ns } = await sb.from('note_subcategorias').select('*').eq('note_id', noteId).limit(1);
  console.log('━━━ note_subcategorias (classificação atual) ━━━');
  if (ns?.[0]) {
    const r = ns[0];
    console.log(`  tipo:           ${r.tipo}`);
    console.log(`  sub_code:       ${r.sub_code}`);
    console.log(`  sub_categoria:  ${r.sub_categoria}`);
    console.log(`  quantidade:     ${r.quantidade}`);
    console.log(`  code:           ${r.code}`);
    console.log(`  code_text:      ${r.code_text}`);
    console.log(`  classified_at:  ${r.classified_at}`);
  } else {
    console.log('  (nota NÃO está classificada — não vai inflar nenhuma subcategoria)');
  }

  // 3) Estado em note_details
  const { data: nd } = await sb.from('note_details').select('note_id, numero, payload, fetched_at').eq('note_id', noteId).limit(1);
  console.log('\n━━━ note_details (cache local) ━━━');
  if (nd?.[0]) {
    const p = nd[0].payload;
    console.log(`  fetched_at:     ${nd[0].fetched_at}`);
    console.log(`  tipo:           ${p?.tipo}`);
    console.log(`  codigo:         ${p?.codigo}`);
    console.log(`  endereco.logradouro: "${p?.endereco?.logradouro || ''}"`);
    console.log(`  endereco.cidade:     "${p?.endereco?.cidade || ''}"`);
    console.log(`  subCategoria:   ${p?.subCategoria}`);
    console.log(`  quantidadeExec: ${p?.quantidadeExec}`);
    console.log(`  atividades:     ${p?.atividades}`);
  } else {
    console.log('  (sem cache local — note_details vazio)');
  }

  // 4) Estado em snapshots (em quais aparece)
  console.log('\n━━━ Snapshots onde a nota aparece ━━━');
  const { data: snaps } = await sb.from('snapshots')
    .select('date, team_name, regional, captured_at, data')
    .order('captured_at', { ascending: false })
    .limit(5000);
  const ocorrencias = [];
  for (const r of (snaps || [])) {
    const t = r.data;
    if (!t) continue;
    ['notasExecutadas', 'notasConcluidas', 'notasRejeitadas', 'notasBaixadas'].forEach(k => {
      (t[k] || []).forEach(n => {
        if (n.id === noteId) ocorrencias.push({ date: r.date, team: r.team_name, reg: r.regional, lista: k, status: n.status, conclusionDate: n.conclusionDate, captured: r.captured_at });
      });
    });
  }
  // Deduplica por (date, team, lista) — pega o mais recente
  const dedup = {};
  ocorrencias.forEach(o => {
    const key = `${o.date}|${o.team}|${o.lista}`;
    if (!dedup[key] || dedup[key].captured < o.captured) dedup[key] = o;
  });
  Object.values(dedup).sort((a, b) => a.date.localeCompare(b.date)).forEach(o => {
    console.log(`  ${o.date} | ${o.reg} | ${o.team} | ${o.lista} | status=${o.status} | conclusao=${o.conclusionDate || '—'}`);
  });
  if (Object.keys(dedup).length === 0) console.log('  (nenhuma — fora de snapshots recentes)');

  // 5) Em team_daily_subcat_totals?
  console.log('\n━━━ Está sendo contada em team_daily_subcat_totals? ━━━');
  // Precisamos cruzar: pega as datas/equipes onde a nota apareceu e olha tdst
  const datasEquipes = [...new Set(Object.values(dedup).map(o => `${o.date}|${o.team}`))];
  if (datasEquipes.length === 0) {
    console.log('  (não há ocorrência em snapshots — não pode estar nos agregados)');
  } else {
    for (const de of datasEquipes) {
      const [d, team] = de.split('|');
      const { data: tds } = await sb.from('team_daily_subcat_totals')
        .select('sub_code, count, quantidade')
        .eq('date', d).eq('team_name', team).eq('tipo', 'DD');
      console.log(`  ${d} | ${team}:`, JSON.stringify(tds));
    }
  }

  // 6) WPA AO VIVO — Address e classificação
  console.log('\n━━━ Chamada AO VIVO no WPA ━━━');
  try {
    const d = await getNoteDetail(noteId, 'DESG');
    if (d) {
      console.log(`  Type:           ${d.Type}`);
      console.log(`  Code:           ${d.Code}`);
      console.log(`  Address:        "${d.Address || ''}"`);
      console.log(`  Neighborhood:   "${d.Neighborhood || ''}"`);
      console.log(`  ExecutionStatus: ${d.ExecutionStatus}  | Status: ${d.Status}`);
      console.log(`  ConclusionDate: ${d.ConclusionDate2 || d.ConclusionDate}`);
      console.log(`  Activities:`);
      (d.Activities || []).forEach(a => {
        console.log(`    - ${a.Activity?.Code} | Amount=${a.Amount} | IsPrimary=${a.IsPrimary} | ${a.Activity?.Description}`);
      });
      const ehRamalBT = /ramal\s+bt/i.test(d.Address || '');
      console.log(`\n  → Address tem "Ramal BT"? ${ehRamalBT ? '✓ SIM' : '✗ NÃO'}`);
    } else {
      console.log('  WPA retornou null');
    }
  } catch (e) {
    console.log('  ERRO WPA:', e.message);
  }

  // 7) Roda o classificador ATUAL pra ver o que daria
  console.log('\n━━━ Re-classificação ao vivo (regra atual) ━━━');
  try {
    const c = await classificar(noteId, 'DD', { sectorId: 'DESG', numero });
    console.log(JSON.stringify({ sub_code: c.sub_code, sub_categoria: c.sub_categoria, quantidade: c.quantidade, code: c.code, activities: c.raw?.activities }, null, 2));
  } catch (e) {
    console.log('  ERRO classificador:', e.message);
  }
})().catch(e => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
