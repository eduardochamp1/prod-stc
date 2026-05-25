#!/usr/bin/env node
/**
 * scripts/diag-rejection-endpoints.js
 *
 * Descobre qual endpoint /api/notes/{path} retorna o campo `Rejection`
 * para cada tipo de nota (MD, LN, DL, LE, II, PO, RL, UG, RD, SO, SF, DD).
 *
 * Estratégia:
 *   1. Pega 1 noteId rejeitado real de cada tipo via Supabase (snapshots).
 *   2. Pra cada tipo, testa uma lista de candidatos de path (md, lnrl, dl, ...).
 *   3. Reporta qual candidato retornou status 200 + Data.Rejection != null.
 *
 * Uso (no servidor):
 *   cd ~/prod-stc
 *   node scripts/diag-rejection-endpoints.js
 *
 * Output: tabela em stdout + arquivo scripts/rejection-endpoints-map.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { login } = require('../services/wpaService');
const { createClient } = require('@supabase/supabase-js');

const WPA_API = process.env.WPA_API_URL || 'https://edp-wpa-web-api.azurewebsites.net';

// Tipos que aparecem em notasRejeitadas nos snapshots
const TIPOS = ['MD', 'LN', 'DL', 'LE', 'II', 'PO', 'RL', 'UG', 'RD', 'SO', 'SF', 'DD'];

// Candidatos de path por tipo. Os já confirmados ficam primeiro.
// Padrões observados na API: tipo direto, tipo+'rl', tipo+'dl', etc.
const CANDIDATES = {
  MD: ['md', 'mdrl', 'mddl', 'medicao'],
  LN: ['lnrl', 'ln', 'lndl', 'lndr', 'ligacaonova'],
  DL: ['dl', 'dlrl', 'dldl', 'desligamento', 'corte'],
  LE: ['le', 'lerl', 'ledl', 'leitura'],
  II: ['ii', 'iirl', 'iidl', 'inspecao'],
  PO: ['po', 'porl', 'podl', 'poda'],
  RL: ['rl', 'rlrl', 'rldl', 'religacao'],
  UG: ['ug', 'ugrl', 'ugdl', 'ugp'],
  RD: ['rd', 'rdrl', 'rddl', 'religamento'],
  SO: ['so', 'sorl', 'sodl', 'servico', 'sobjetivo'],
  SF: ['sfdl', 'sfrl', 'sf'],
  DD: ['dd', 'ddrl', 'dddl'],
};

const MAX_SAMPLES_PER_TIPO = 5;  // tenta até 5 noteIds diferentes antes de desistir

const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// Cache de samples já coletados: { tipo: [noteId, noteId, ...] }
let _samplesCache = null;

async function loadSamples() {
  if (_samplesCache) return _samplesCache;
  console.log('🔎 Varrendo snapshots recentes pra coletar samples por tipo...');
  // Cada linha de snapshots = 1 equipe; data.notasRejeitadas[] tem { id, tipoCode }
  const PAGE = 1000;
  const samples = {};   // { TIPO: Set<noteId> }
  let from = 0;
  let pulled = 0;
  while (true) {
    const { data, error } = await supa
      .from('snapshots')
      .select('data')
      .order('captured_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    pulled += data.length;

    for (const row of data) {
      const lista = row?.data?.notasRejeitadas || [];
      for (const n of lista) {
        const t = String(n?.tipoCode || n?.Type || n?.tipo || '').toUpperCase();
        const id = n?.id || n?.Id || n?.noteId || n?.NoteId;
        if (!t || !id) continue;
        if (!samples[t]) samples[t] = new Set();
        samples[t].add(id);
      }
    }
    // Cobertura: se todos os tipos já têm ≥1 sample, para
    const cobertos = TIPOS.every(t => samples[t] && samples[t].size > 0);
    if (cobertos) { console.log(`   ✅ todos os tipos cobertos após ${pulled} snapshots`); break; }
    if (data.length < PAGE) break;
    from += PAGE;
    if (from > 20000) { console.log(`   ⚠️ limite 20k snapshots atingido`); break; }
  }
  console.log(`   total ${pulled} snapshots lidos`);
  _samplesCache = samples;
  return samples;
}

async function pickRejectedNoteIdsByTipo(tipo, max = MAX_SAMPLES_PER_TIPO) {
  const samples = await loadSamples();
  const set = samples[tipo];
  if (!set || set.size === 0) return [];
  return Array.from(set).slice(0, max);
}

async function tryCandidate(token, noteId, candidate) {
  const url = `${WPA_API}/api/notes/${candidate}?noteId=${noteId}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
  } catch (err) {
    return { ok: false, reason: `fetch error: ${err.message}` };
  }
  if (res.status === 404) return { ok: false, reason: '404' };
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch {}
    return { ok: false, reason: `HTTP ${res.status}`, body };
  }

  let json;
  try { json = await res.json(); } catch { return { ok: false, reason: 'invalid JSON' }; }
  const rej = json?.Data?.Rejection;
  const rejRen = json?.Data?.RejectionRen1000;
  if (!rej && !rejRen) return { ok: false, reason: 'no Rejection field' };

  const reasons = rej?.RejectionReasons || rejRen?.RejectionReasons || [];
  return {
    ok: true,
    reasonsCount: reasons.length,
    sampleCode: reasons[0]?.Code || null,
    hasObservation: !!(rej?.Observation || rejRen?.RejectionHeader?.Observation),
  };
}

(async () => {
  console.log('🔐 Login WPA...');
  const token = await login();
  console.log('✅ Login ok');

  const results = {};
  for (const tipo of TIPOS) {
    process.stdout.write(`\n[${tipo}] `);
    const noteIds = await pickRejectedNoteIdsByTipo(tipo);
    if (noteIds.length === 0) {
      console.log('❌ nenhuma nota rejeitada nos snapshots');
      results[tipo] = { sampleCount: 0, endpoint: null, reason: 'no sample' };
      continue;
    }
    console.log(`${noteIds.length} sample(s) disponíveis`);

    let found = null;
    // Pra cada candidato, tenta vários noteIds — se algum funcionar, vence
    for (const cand of CANDIDATES[tipo] || []) {
      let candResult = null;
      const errors = [];
      for (const nid of noteIds) {
        const r = await tryCandidate(token, nid, cand);
        if (r.ok) { candResult = r; break; }
        errors.push(`${nid.slice(0, 8)}=${r.reason}`);
      }
      if (candResult) {
        console.log(`   ✅ /${cand} → ${candResult.reasonsCount} motivos (ex: ${candResult.sampleCode})`);
        if (!found) found = { candidate: cand, ...candResult };
      } else {
        // Se TODOS os erros foram 404, endpoint não existe; senão tem chance
        const all404 = errors.every(e => e.includes('404'));
        const tag = all404 ? '  ' : '⚠️';
        console.log(`   ${tag} /${cand} → ${errors.slice(0, 3).join(', ')}${errors.length > 3 ? '...' : ''}`);
      }
    }
    results[tipo] = {
      sampleCount: noteIds.length,
      endpoint: found?.candidate || null,
      ...(found || {}),
    };
  }

  const outPath = path.join(__dirname, 'rejection-endpoints-map.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n📝 Mapa salvo em: ${outPath}`);

  console.log('\n=== RESUMO ===');
  for (const [tipo, r] of Object.entries(results)) {
    if (r.endpoint) {
      console.log(`  ${tipo} → /api/notes/${r.endpoint}  (${r.reasonsCount} motivos)`);
    } else {
      console.log(`  ${tipo} → ❌ não mapeado (${r.reason || 'sem amostra'})`);
    }
  }
  process.exit(0);
})().catch(err => {
  console.error('💥 erro:', err);
  process.exit(1);
});
