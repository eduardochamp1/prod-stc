#!/usr/bin/env node
/**
 * scripts/diag-app-settings.js — audita a tabela app_settings. Read-only.
 *
 * POR QUE EXISTE (13/08/2026): até o fix do P1-18, GET/PUT /api/settings/:key
 * gravava QUALQUER chave de app_settings só com autenticação — sem guarda de dono
 * nem role. Uma conta comum podia escrever em chaves operacionais (metas_diarias,
 * snapshot_last_ok, contador-transgressao…) ou inventar chaves arbitrárias.
 *
 * app_settings NÃO tem coluna de autor — então não dá pra atribuir uma escrita a
 * uma conta. O que dá pra fazer, e é o sinal mais forte de abuso, é listar todas
 * as chaves e DESTACAR as que estão FORA do conjunto legítimo (chave desconhecida,
 * ou monitor-filters:<usuário-que-não-existe>). Chave inesperada = alguém gravou
 * algo que o código nunca grava.
 *
 * USO (na VM):
 *   node scripts/diag-app-settings.js
 *   node scripts/diag-app-settings.js --dump   # imprime o valor de cada chave
 */

require('dotenv').config();
const { _getPool } = require('../services/pgShim');

// Chaves fixas que o código legitimamente grava (grep setSetting em routes/services).
const CHAVES_FIXAS = new Set([
  'metas_diarias',
  'contador-transgressao',
  'desloc-threshold',
  'snapshot_last_ok',
  'snapshot_error',
  'subcat_error',
  'subcat_pending',
  'drift_last_repair',
  'drift_last_skip',
  'reclassify_job',
  'monitor-filters',        // legado: filtro GLOBAL antes de virar por-usuário
]);

// Usuários válidos vêm do AUTH_USERS (mesma fonte do login). username = antes do 1º ':'.
function usuariosValidos() {
  const raw = process.env.AUTH_USERS || '';
  const set = new Set();
  for (const entry of raw.split(',')) {
    const u = entry.split(':')[0].trim();
    if (u) set.add(u);
  }
  return set;
}

function classifica(key, usuarios) {
  if (CHAVES_FIXAS.has(key)) return { ok: true, motivo: 'operacional' };
  if (key.startsWith('monitor-filters:')) {
    const user = key.slice('monitor-filters:'.length);
    if (usuarios.has(user)) return { ok: true, motivo: `filtro de ${user}` };
    return { ok: false, motivo: `filtro de usuário INEXISTENTE: "${user}"` };
  }
  return { ok: false, motivo: 'CHAVE DESCONHECIDA — código nunca grava isto' };
}

async function main() {
  const dump = process.argv.includes('--dump');
  const pool = _getPool();
  const usuarios = usuariosValidos();

  const { rows } = await pool.query(
    `SELECT key, updated_at, pg_column_size(data) AS bytes, data
       FROM app_settings ORDER BY updated_at DESC NULLS LAST`);

  console.log(`\n🔐 Auditoria de app_settings — ${rows.length} chave(s)`);
  console.log(`   usuários válidos (AUTH_USERS): ${usuarios.size ? [...usuarios].join(', ') : '⚠️ AUTH_USERS vazio no shell — nomes não validados'}\n`);
  console.log('S'.padEnd(3) + 'chave'.padEnd(34) + 'atualizado'.padEnd(22) + 'bytes'.padStart(7) + '  classificação');
  console.log('-'.repeat(96));

  const suspeitas = [];
  for (const r of rows) {
    const cls = classifica(r.key, usuarios);
    if (!cls.ok) suspeitas.push(r);
    const flag = cls.ok ? 'ok' : '⚠️';
    const quando = r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 19).replace('T', ' ') : '—';
    console.log(
      flag.padEnd(3) +
      String(r.key).slice(0, 33).padEnd(34) +
      quando.padEnd(22) +
      String(r.bytes ?? '?').padStart(7) +
      '  ' + cls.motivo);
    if (dump) {
      const s = JSON.stringify(r.data);
      console.log('     └─ ' + (s.length > 300 ? s.slice(0, 300) + '…' : s));
    }
  }

  console.log('-'.repeat(96));
  if (suspeitas.length === 0) {
    console.log(`\n✅ Nenhuma chave fora do conjunto legítimo. Nada indica escrita indevida`);
    console.log(`   pela brecha do P1-18 (embora a ausência de coluna de autor impeça prova`);
    console.log(`   definitiva — isto descarta o caso mais provável: chave inventada).`);
  } else {
    console.log(`\n⚠️  ${suspeitas.length} chave(s) SUSPEITA(S) — não fazem parte do que o código grava:`);
    for (const r of suspeitas) console.log(`   • ${r.key}   (atualizado ${r.updated_at || '—'})`);
    console.log(`\n   Investigue: rode de novo com --dump pra ver o conteúdo. Se for lixo de`);
    console.log(`   teste/abuso, pode remover com:`);
    console.log(`     DELETE FROM app_settings WHERE key = '<chave>';`);
    console.log(`   (⚠️ confira o conteúdo ANTES — algumas podem ser chaves novas legítimas`);
    console.log(`    que este script ainda não conhece; nesse caso, adicione a CHAVES_FIXAS.)`);
  }
  console.log('');
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(0); })
  .catch(async (e) => { console.error(e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
