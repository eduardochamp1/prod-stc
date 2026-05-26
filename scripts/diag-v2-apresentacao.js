#!/usr/bin/env node
/**
 * scripts/diag-v2-apresentacao.js
 *
 * Dumpa TODOS os campos do /teamsstatus/V2 pra uma equipe específica,
 * pra descobrir qual campo corresponde à "Hr. Apresentação" mostrada na
 * tela Gestão de Equipes da EDP.
 *
 * Contexto: equipes com sessão aberta desde o dia anterior mostram no
 * nosso Monitor o sessionBegin antigo (ex: 25/05 08:00), mas a EDP exibe
 * "Hr. Apresentação" do dia atual (ex: 26/05 15:18). Queremos achar o
 * campo do V2 que bate com esse horário recente.
 *
 * Uso:
 *   node scripts/diag-v2-apresentacao.js ECPIU50
 *   node scripts/diag-v2-apresentacao.js ECPIU50 DESG   # força setor
 */

require('dotenv').config();
const { login, getV2Cached } = require('../services/wpaService');

const SIGLA  = (process.argv[2] || '').toUpperCase().trim();
const SETOR  = process.argv[3] || null;
const SECTORS = SETOR ? [SETOR] : ['DESG', 'DEPT', 'DESC'];

if (!SIGLA) {
  console.error('Uso: node scripts/diag-v2-apresentacao.js SIGLA [SETOR]');
  process.exit(1);
}

function isTimestampLike(v) {
  return typeof v === 'string' && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);
}

(async () => {
  await login();
  console.log(`🔎 Procurando ${SIGLA} no V2...\n`);

  let found = null;
  let foundSector = null;
  for (const sector of SECTORS) {
    let list;
    try { list = await getV2Cached(sector); }
    catch (e) { console.warn(`  ${sector}: ${e.message}`); continue; }
    const match = (list || []).find(item => {
      const nome = (item.Session?.Team?.Name || item.Team?.Name || '').trim().toUpperCase();
      return nome === SIGLA;
    });
    if (match) { found = match; foundSector = sector; break; }
  }

  if (!found) {
    console.log(`❌ ${SIGLA} não encontrada no V2 de ${SECTORS.join('/')}`);
    process.exit(0);
  }

  console.log(`✅ Achada em ${foundSector}\n`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TODOS OS CAMPOS COM TIMESTAMP (procure o ~15:18 de hoje)');
  console.log('═══════════════════════════════════════════════════════════');

  // Varre recursivamente buscando campos com timestamp
  function walk(obj, path = '') {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const full = path ? `${path}.${k}` : k;
      if (isTimestampLike(v)) {
        console.log(`  ${full.padEnd(45)} = ${v}`);
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, full);
      } else if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        // Só primeiro item de arrays de objetos (evita poluir)
        walk(v[0], `${full}[0]`);
      }
    }
  }
  walk(found);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  CAMPOS DE NÍVEL 1 (todos, pra contexto)');
  console.log('═══════════════════════════════════════════════════════════');
  for (const [k, v] of Object.entries(found)) {
    const tipo = Array.isArray(v) ? `array[${v.length}]` : typeof v;
    let preview = '';
    if (v === null) preview = 'null';
    else if (typeof v !== 'object') preview = String(v).slice(0, 60);
    else if (Array.isArray(v)) preview = `[${v.length} itens]`;
    else preview = `{${Object.keys(v).slice(0, 6).join(', ')}...}`;
    console.log(`  ${k.padEnd(28)} (${tipo}): ${preview}`);
  }

  // Session sub-objeto (onde costuma estar o begin)
  if (found.Session) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  found.Session (campos de nível 1)');
    console.log('═══════════════════════════════════════════════════════════');
    for (const [k, v] of Object.entries(found.Session)) {
      if (typeof v !== 'object' || v === null) {
        console.log(`  Session.${k.padEnd(26)} = ${v}`);
      }
    }
  }

  process.exit(0);
})().catch(err => { console.error('💥', err); process.exit(1); });
