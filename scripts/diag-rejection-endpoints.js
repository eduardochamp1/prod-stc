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
  MD: ['md', 'mdrl', 'mddl'],
  LN: ['lnrl', 'ln', 'lndl'],
  DL: ['dl', 'dlrl', 'dldl', 'desligamento'],
  LE: ['le', 'lerl', 'ledl', 'leitura'],
  II: ['ii', 'iirl', 'iidl', 'inspecao'],
  PO: ['po', 'porl', 'podl', 'poda'],
  RL: ['rl', 'rlrl', 'religacao'],
  UG: ['ug', 'ugrl', 'ugdl'],
  RD: ['rd', 'rdrl', 'rddl', 'religamento'],
  SO: ['so', 'sorl', 'sodl', 'servico'],
  SF: ['sfdl', 'sfrl', 'sf'],
  DD: ['dd', 'ddrl', 'dddl'],
};

const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

async function pickRejectedNoteIdByTipo(tipo) {
  // Busca em snapshots recentes uma nota rejeitada do tipo desejado.
  // Estrutura: snapshots.payload é JSONB array de equipes; cada equipe tem
  // notas com Tipo + Status + Id (uuid).
  // Como o schema exato pode variar, usamos JSONB path queries via RPC ou
  // varremos os snapshots mais recentes.
  const { data, error } = await supa
    .from('snapshots')
    .select('payload')
    .order('captured_at', { ascending: false })
    .limit(20);
  if (error) throw error;

  for (const row of data || []) {
    const payload = row.payload;
    // payload pode ser array de equipes, cada uma com Notas[] ou Rejected[] etc.
    const equipes = Array.isArray(payload) ? payload : (payload?.equipes || payload?.teams || []);
    for (const eq of equipes) {
      const buckets = [
        eq?.notasRejeitadas, eq?.NotasRejeitadas,
        eq?.Rejected, eq?.RejectedNotes,
      ].filter(Array.isArray);
      for (const bucket of buckets) {
        for (const n of bucket) {
          const t = (n?.Tipo || n?.Type || n?.tipo || '').toUpperCase();
          const id = n?.Id || n?.NoteId || n?.id || n?.noteId;
          if (t === tipo && id) return id;
        }
      }
    }
  }
  return null;
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
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

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
    process.stdout.write(`[${tipo}] buscando noteId rejeitado... `);
    const noteId = await pickRejectedNoteIdByTipo(tipo);
    if (!noteId) {
      console.log('❌ nenhuma nota rejeitada encontrada nos snapshots recentes');
      results[tipo] = { noteId: null, endpoint: null, reason: 'no sample' };
      continue;
    }
    console.log(noteId);

    let found = null;
    for (const cand of CANDIDATES[tipo] || []) {
      const r = await tryCandidate(token, noteId, cand);
      const tag = r.ok ? '✅' : '  ';
      console.log(`   ${tag} /${cand} → ${r.ok ? `${r.reasonsCount} motivos (ex: ${r.sampleCode})` : r.reason}`);
      if (r.ok && !found) found = { candidate: cand, ...r };
    }
    results[tipo] = { noteId, endpoint: found?.candidate || null, ...(found || {}) };
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
