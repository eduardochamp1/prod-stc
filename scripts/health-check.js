#!/usr/bin/env node
/**
 * scripts/health-check.js — raio-X de saúde da aplicação. Read-only.
 *
 * Responde, com veredito por seção (✅ ok / ⚠️ atenção / 🔴 grave), às 3 perguntas:
 *   1. ESTÁ RODANDO?      — ingestão viva (último snapshot recente), erros do cron.
 *   2. DADOS CONFIÁVEIS?  — a tabela agregada bate com os snapshots (drift), e a
 *                           produção reportável não teve queda anômala.
 *   3. DEGRADOU?          — crescimento das tabelas, cobertura de coleta, retenção.
 *
 * Leva ~30-60s (o bloco de drift roda consolidateDay em dryRun pra 7 dias).
 *
 * USO (na VM):
 *   node scripts/health-check.js
 *   node scripts/health-check.js --dias=14     # janela do bloco de drift/produção
 */

require('dotenv').config();
const { _getPool } = require('./../services/pgShim');
const { detectDrift } = require('../services/dataWriter');
const { getSiglas } = require('../services/equipesOficiais');
const { getSetting } = require('../db/queries');

const arg = (name, def) => {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : def;
};
const DIAS = Math.max(3, Math.min(31, parseInt(arg('dias', '7'), 10) || 7));

const nowBRT = () => new Date(Date.now() - 3 * 3600_000);
const ymd = (v) => {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth()+1).padStart(2,'0')}-${String(v.getUTCDate()).padStart(2,'0')}`;
  return String(v || '').slice(0, 10);
};
const min = (n) => `${Math.round(n)}min`;

let _alertas = 0, _graves = 0;
const OK = '✅', WARN = '⚠️ ', BAD = '🔴';
function verdict(level, msg) {
  if (level === 'bad') { _graves++; console.log(`  ${BAD} ${msg}`); }
  else if (level === 'warn') { _alertas++; console.log(`  ${WARN} ${msg}`); }
  else console.log(`  ${OK} ${msg}`);
}
function head(t) { console.log(`\n━━ ${t} ${'━'.repeat(Math.max(0, 60 - t.length))}`); }

async function bloco1_rodando(pool) {
  head('1. ESTÁ RODANDO? (ingestão + cron)');
  const brt = nowBRT();
  const horaBRT = brt.getUTCHours() + brt.getUTCMinutes() / 60;
  const janela = horaBRT >= 5.5 && horaBRT <= 23.75;   // snapshot */15 5-23

  // Idade do snapshot mais recente na tabela bruta
  const { rows: [r] } = await pool.query(`SELECT max(captured_at) AS ult FROM snapshots`);
  if (!r.ult) { verdict('bad', 'nenhum snapshot na tabela — ingestão nunca rodou?'); }
  else {
    const idadeMin = (Date.now() - new Date(r.ult).getTime()) / 60000;
    const quando = new Date(r.ult).toISOString().replace('T', ' ').slice(0, 19);
    if (janela && idadeMin > 30) verdict('bad', `último snapshot há ${min(idadeMin)} (${quando} UTC) — DENTRO da janela de coleta, deveria ser <20min. Ingestão parada?`);
    else if (janela && idadeMin > 20) verdict('warn', `último snapshot há ${min(idadeMin)} — um pouco atrasado (esperado ~15min).`);
    else verdict('ok', `último snapshot há ${min(idadeMin)} (${quando} UTC)${janela ? '' : ' — fora da janela de coleta, ok'}.`);
  }

  // Sinais persistidos do cron
  const okSet  = await getSetting('snapshot_last_ok');
  const errSet = await getSetting('snapshot_error');
  const subErr = await getSetting('subcat_error');
  if (okSet?.data?.ts) {
    const idade = (Date.now() - new Date(okSet.data.ts).getTime()) / 60000;
    verdict(janela && idade > 30 ? 'warn' : 'ok', `snapshot_last_ok há ${min(idade)} (teams=${okSet.data.teams ?? '?'}, ghosts=${okSet.data.ghosts ?? '?'}).`);
  } else verdict('warn', 'sem snapshot_last_ok registrado.');

  if (errSet?.data?.message) {
    const idade = (Date.now() - new Date(errSet.data.ts).getTime()) / 60000;
    const recente = idade < 60;
    verdict(recente ? 'bad' : 'warn', `snapshot_error ${recente ? 'RECENTE' : `há ${min(idade)}`}: "${String(errSet.data.message).slice(0, 120)}"`);
  } else verdict('ok', 'sem snapshot_error pendente.');

  if (subErr?.data?.message) verdict('warn', `subcat_error: "${String(subErr.data.message).slice(0, 100)}"`);
}

async function bloco2_confiaveis(pool) {
  head(`2. DADOS CONFIÁVEIS? (drift + produção, ${DIAS} dias)`);

  // 2a. DRIFT: a tabela agregada bate com os snapshots? (régua D+1, via detectDrift)
  const hojeBRT = ymd(nowBRT());
  const base = new Date(hojeBRT + 'T12:00:00Z');
  let comDrift = 0, checados = 0, somaAbs = 0;
  for (let d = DIAS; d >= 1; d--) {          // D-DIAS .. D-1 (hoje ainda corre)
    const dia = new Date(base); dia.setUTCDate(dia.getUTCDate() - d);
    const iso = ymd(dia);
    try {
      const r = await detectDrift(iso);
      checados++; somaAbs += r.abs_diff;
      if (r.has_drift) { comDrift++;
        verdict(r.diff < 0 ? 'warn' : 'bad',
          `drift ${iso}: tabela ${r.table_count} × régua ${r.snapshot_count} (${r.diff > 0 ? '+' : ''}${r.diff}, limiar ${r.threshold})` +
          (r.diff < 0 ? ' — tabela ACIMA da régua (P2-13, conservador)' : ' — FALTA produção, re-consolidar'));
      }
    } catch (e) { verdict('warn', `drift ${iso}: erro ${e.message.slice(0, 60)}`); }
  }
  if (comDrift === 0) verdict('ok', `${checados} dias sem drift acima do limiar (desvio abs. total ${somaAbs} OS — ruído normal).`);
  else console.log(`     (${comDrift}/${checados} dias com drift; negativos = P2-13 conhecido; positivos = re-consolidar)`);

  // 2b. PRODUÇÃO reportável por dia — queda anômala denuncia coleta furada
  const siglas = getSiglas();
  const { rows } = await pool.query(
    `SELECT date::date AS d, sum(count)::int AS n
       FROM team_daily_totals
      WHERE team_name = ANY($1::text[]) AND date::date >= (CURRENT_DATE - $2::int)
      GROUP BY 1 ORDER BY 1`, [siglas, DIAS + 1]);
  const uteis = rows.filter(r => { const wd = new Date(ymd(r.d) + 'T12:00:00Z').getUTCDay(); return wd !== 0 && wd !== 6; });
  if (uteis.length >= 3) {
    const vals = uteis.map(r => r.n).sort((a, b) => a - b);
    const mediana = vals[Math.floor(vals.length / 2)];
    const baixos = uteis.filter(r => r.n < mediana * 0.5);
    console.log(`     produção/dia útil (whitelist): ${uteis.map(r => `${ymd(r.d).slice(5)}=${r.n}`).join('  ')}`);
    if (baixos.length) verdict('warn', `dia(s) útil com produção <50% da mediana (${mediana}): ${baixos.map(r => ymd(r.d)).join(', ')} — checar coleta desses dias.`);
    else verdict('ok', `produção estável (mediana ${mediana}/dia útil, sem quedas anômalas).`);
  } else verdict('warn', 'poucos dias úteis no período pra avaliar tendência de produção.');
}

async function bloco3_degradou(pool) {
  head('3. DEGRADOU COM O TEMPO? (crescimento + cobertura)');

  // 3a. Tamanho e crescimento das tabelas
  const { rows: tam } = await pool.query(
    `SELECT relname, n_live_tup AS linhas, pg_total_relation_size(relid) AS bytes
       FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 6`);
  for (const t of tam) {
    const mb = t.bytes / 1048576;
    console.log(`     ${String(t.relname).padEnd(26)} ${String(t.linhas).padStart(9)} linhas   ${mb.toFixed(1).padStart(8)} MB`);
  }
  const snaps = tam.find(t => t.relname === 'snapshots');
  if (snaps) {
    const gb = snaps.bytes / 1073741824;
    const retencao = parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '0', 10);
    if (gb > 8) verdict('warn', `snapshots com ${gb.toFixed(1)} GB e retenção ${retencao > 0 ? retencao + 'd' : 'ILIMITADA'} — VM tem ~3.8GB RAM; vigiar disco (df -h).`);
    else verdict('ok', `snapshots ${gb.toFixed(2)} GB (retenção ${retencao > 0 ? retencao + 'd' : 'ilimitada'}) — sem pressão de disco aparente.`);
  }

  // 3b. Cobertura: dias úteis SEM snapshot no período (buraco de coleta)
  const { rows: cob } = await pool.query(
    `SELECT date::date AS d, count(*)::int AS snaps
       FROM snapshots WHERE date::date >= (CURRENT_DATE - $1::int) GROUP BY 1`, [DIAS + 1]);
  const temSnap = new Set(cob.map(r => ymd(r.d)));
  const faltando = [];
  const base = new Date(ymd(nowBRT()) + 'T12:00:00Z');
  for (let d = DIAS; d >= 1; d--) {
    const dia = new Date(base); dia.setUTCDate(dia.getUTCDate() - d);
    const wd = dia.getUTCDay(); if (wd === 0 || wd === 6) continue;   // fim de semana
    const iso = ymd(dia);
    if (!temSnap.has(iso)) faltando.push(iso);
  }
  if (faltando.length) verdict('bad', `dia(s) ÚTIL sem NENHUM snapshot: ${faltando.join(', ')} — coleta ficou fora nesses dias.`);
  else verdict('ok', `todos os dias úteis dos últimos ${DIAS} têm snapshots.`);

  // 3c. Snapshot mais antigo retido (referência de retenção)
  const { rows: [velho] } = await pool.query(`SELECT min(date) AS ini FROM snapshots`);
  if (velho?.ini) console.log(`     histórico retido desde ${ymd(velho.ini)}.`);
}

async function main() {
  const pool = _getPool();
  console.log(`\n🩺 HEALTH-CHECK · ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC · janela ${DIAS} dias`);
  await bloco1_rodando(pool);
  await bloco2_confiaveis(pool);
  await bloco3_degradou(pool);

  head('VEREDITO');
  if (_graves === 0 && _alertas === 0) console.log(`  ${OK} Saudável. Nada acima do limiar em nenhum bloco.`);
  else console.log(`  ${_graves ? BAD : WARN} ${_graves} grave(s), ${_alertas} alerta(s). Reveja os itens marcados acima.`);
  console.log('');
}

main()
  .then(async () => { try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(_graves ? 2 : 0); })
  .catch(async (e) => { console.error('health-check falhou:', e); try { const p = _getPool(); if (p && p.end) await p.end(); } catch (_) {} process.exit(1); });
