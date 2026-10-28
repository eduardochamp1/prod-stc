#!/usr/bin/env node
/**
 * scripts/diag-paridade-backfill.js — o dia montado DEPOIS de fechado (backfill)
 * dá o mesmo número que o dia montado ao vivo? Read-only. NÃO grava nada.
 *
 * POR QUE EXISTE (28/10/2026, backlog P0-12 passo 1): o José decidiu trocar a
 * coleta contínua (snapshot a cada 15 min) por janelas às 08h, 12h e 17h mais um
 * fechamento do D-1 às 05h pelo caminho do backfill (`getTeamsByDate`). Os dois
 * caminhos montam as notas de fontes diferentes — ao vivo, as concluídas vêm do
 * `V2.Concluded[]`; no backfill, de `notes/executed/{id}/session` — e o número
 * que sai daqui é reportado à EDP (regra 7). Antes de mudar a agenda, cada
 * diferença tem de estar medida e explicada.
 *
 * O QUE COMPARA, para cada dia D (régua = passe de D+1, igual ao detectDrift):
 *   TABELA   team_daily_totals de D (o número oficial gravado)
 *   AO VIVO  consolidateDay(D+1, dryRun) com os snapshots do banco
 *   BACKFILL consolidateDay(D+1, dryRun) só com o backfill de D, D+1 e D+2
 *   JANELAS  backfill + só os snapshots das 08h, 12h e 17h — o modelo novo
 * Mais: notas concluídas que um caminho vê e o outro não (amostra), e logon /
 * logoff por equipe (o backfill traz BeginTime/EndTime direto do Sessions/all).
 *
 * REDE: o backfill chama a EDP — por setor e data, 1 `Sessions/all/date` + 5 por
 * sessão Engelmig (executed, downloaded, rejected, surveyed, detalhe), ~400 por
 * data com ~80 sessões. Por isso: setores um de cada vez, resultado guardado em
 * logs/paridade-cache/ (rodar de novo não chama a EDP), e o total de requisições
 * do contador no fim. `--sem-rede` usa só o cache e falha se faltar algo.
 *
 * USO (na VM, com o WPA_PROXY no ar):
 *   node scripts/diag-paridade-backfill.js 2026-10-20 2026-10-22
 *   node scripts/diag-paridade-backfill.js 2026-10-20 --sem-rede
 * D+2 tem de estar fechado: o último dia aceito é hoje-3 (BRT).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { getClient } = require('../services/dbClient');
const { consolidateDay, _unionTeamsFromSnapshots } = require('../services/dataWriter');
const { comOrigem, resumo } = require('../services/wpaContador');

const CACHE_DIR = path.join(__dirname, '..', 'logs', 'paridade-cache');
const SETORES = ['DESG', 'DEPT', 'DESC', 'DSSJ'];   // os mesmos do POST /admin/backfill
const JANELAS_H = [8, 12, 17];
const TOL_LOGON_MIN = 5;
const AMOSTRA = 10;

function addDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function hojeBRT() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/** {data:'YYYY-MM-DD', h:0-23, min} do captured_at em BRT. */
function brt(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), min: Number(p.minute) };
}

// ── PURAS (exportadas para teste) ─────────────────────────────────────────────

/** Snapshot gravado pelo backfill tem `notasVistoriadas`; o ao vivo não tem. */
function ehSnapshotDeBackfill(row) {
  return Boolean(row && row.data && Array.isArray(row.data.notasVistoriadas));
}

/**
 * Do conjunto de snapshots ao vivo, só os do 1º ciclo a partir de cada janela
 * (08:00, 12:00, 17:00 BRT, até :20) — o que o modelo novo teria gravado. Um
 * ciclo = linhas com captured_at até 2 min depois da primeira.
 */
function snapshotsDasJanelas(rows, horas = JANELAS_H) {
  const porDiaHora = new Map();
  for (const r of rows) {
    const t = brt(r.captured_at);
    if (!horas.includes(t.h) || t.min > 20) continue;
    const k = `${t.data}|${t.h}`;
    const ms = new Date(r.captured_at).getTime();
    const atual = porDiaHora.get(k);
    if (atual === undefined || ms < atual) porDiaHora.set(k, ms);
  }
  const inicios = [...porDiaHora.values()];
  return rows.filter(r => {
    const ms = new Date(r.captured_at).getTime();
    return inicios.some(i => ms >= i && ms - i <= 2 * 60_000);
  });
}

/** Equipes do backfill → linhas no formato de `snapshots` (as do fim do dia). */
function comoSnapshots(teams, data) {
  const captured_at = new Date(`${addDias(data, 1)}T02:59:00Z`).toISOString();   // 23:59 BRT
  return teams.map(t => ({
    team_name: t.teamName || t.sigla, regional: t.regional, sector_id: t.sectorId, captured_at, data: t,
  }));
}

/** rows do dryRun → Map(equipe → count) só do dia D. */
function porEquipe(rows, dia) {
  const m = new Map();
  for (const r of rows || []) {
    if (r.date !== dia) continue;
    m.set(r.team_name, (m.get(r.team_name) || 0) + r.count);
  }
  return m;
}

function soma(m) { let s = 0; for (const v of m.values()) s += v; return s; }

/** Diferença por equipe (b − a), só as ≠ 0, maior módulo primeiro. */
function difPorEquipe(a, b) {
  const nomes = new Set([...a.keys(), ...b.keys()]);
  return [...nomes]
    .map(n => ({ equipe: n, a: a.get(n) || 0, b: b.get(n) || 0, dif: (b.get(n) || 0) - (a.get(n) || 0) }))
    .filter(x => x.dif !== 0)
    .sort((x, y) => Math.abs(y.dif) - Math.abs(x.dif) || x.equipe.localeCompare(y.equipe));
}

/** Map(equipe → Map(id → nota)) das concluídas da união, só sessões de D. */
function concluidasPorEquipe(snaps, dia) {
  const out = new Map();
  for (const t of _unionTeamsFromSnapshots(snaps, dia, addDias(dia, -1))) {
    if (t._effDate !== dia) continue;
    const m = out.get(t.teamName) || new Map();
    for (const n of t.notasConcluidas || []) {
      const id = n && (n.id || n.codigo);
      if (id && !m.has(id)) m.set(id, { ...n, sessionBegin: t.sessionBegin });
    }
    out.set(t.teamName, m);
  }
  return out;
}

/** Notas que `a` tem e `b` não, por equipe. */
function soEmUm(a, b) {
  const out = [];
  for (const [equipe, notas] of a) {
    const outro = b.get(equipe) || new Map();
    for (const [id, n] of notas) {
      if (!outro.has(id)) out.push({ equipe, id, codigo: n.codigo, tipo: n.tipoCode, conclusao: n.conclusionDate || null });
    }
  }
  return out;
}

/** 1º logon e último logoff por equipe com sessão em D. */
function logonLogoff(snaps, dia) {
  const m = new Map();
  for (const s of snaps) {
    const t = s.data;
    if (!t || !t.sessionBegin || brt(t.sessionBegin).data !== dia) continue;
    const e = m.get(s.team_name) || { begin: null, end: null };
    if (!e.begin || t.sessionBegin < e.begin) e.begin = t.sessionBegin;
    if (t.sessionEnd && (!e.end || t.sessionEnd > e.end)) e.end = t.sessionEnd;
    m.set(s.team_name, e);
  }
  return m;
}

function difMin(a, b) {
  if (!a || !b) return null;
  return Math.round(Math.abs(new Date(a) - new Date(b)) / 60_000);
}

function compararLogon(vivo, back) {
  const r = { equipes: 0, logonIgual: 0, logoffIgual: 0, soAoVivo: [], soBackfill: [], logonDif: [], logoffDif: [] };
  for (const nome of new Set([...vivo.keys(), ...back.keys()])) {
    const v = vivo.get(nome), b = back.get(nome);
    if (!b) { r.soAoVivo.push(nome); continue; }
    if (!v) { r.soBackfill.push(nome); continue; }
    r.equipes++;
    const dl = difMin(v.begin, b.begin);
    if (dl !== null && dl <= TOL_LOGON_MIN) r.logonIgual++;
    else r.logonDif.push({ equipe: nome, aoVivo: v.begin, backfill: b.begin, min: dl });
    const df = difMin(v.end, b.end);
    if (df !== null && df <= TOL_LOGON_MIN) r.logoffIgual++;
    else r.logoffDif.push({ equipe: nome, aoVivo: v.end, backfill: b.end, min: df });
  }
  return r;
}

// ── REDE / BANCO ──────────────────────────────────────────────────────────────

async function backfillDoDia(data, semRede) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const teams = [];
  for (const setor of SETORES) {
    const arq = path.join(CACHE_DIR, `${setor}-${data}.json`);
    if (fs.existsSync(arq)) {
      teams.push(...JSON.parse(fs.readFileSync(arq, 'utf8')));
      continue;
    }
    if (semRede) throw new Error(`--sem-rede e sem cache: ${arq}`);
    // Lazy: com --sem-rede o wpaService nem carrega (não tenta login).
    const { getTeamsByDate } = require('../services/wpaService');
    console.log(`   EDP: backfill ${setor} ${data}...`);
    // Setor que falha derruba tudo: dado parcial aqui viraria "diferença" falsa.
    const doSetor = await comOrigem('script:paridade', () => getTeamsByDate(setor, data));
    fs.writeFileSync(arq, JSON.stringify(doSetor));
    teams.push(...doSetor);
  }
  return comoSnapshots(teams, data);
}

async function snapshotsDoBanco(datas) {
  const { data, error } = await getClient()
    .from('snapshots')
    .select('team_name, regional, sector_id, captured_at, data')
    .in('date', datas)
    .order('captured_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function tabelaPorEquipe(dia) {
  const { data, error } = await getClient()
    .from('team_daily_totals').select('team_name, count').eq('date', dia);
  if (error) throw error;
  const m = new Map();
  for (const r of data || []) m.set(r.team_name, (m.get(r.team_name) || 0) + (r.count || 0));
  return m;
}

const ordemDesc = (a, b) => new Date(b.captured_at) - new Date(a.captured_at);

async function dryRun(dia, snaps) {
  const r = await consolidateDay(addDias(dia, 1), { dryRun: true, snaps: [...snaps].sort(ordemDesc) });
  return porEquipe(r && r.rows, dia);
}

function imprimirDif(titulo, dif) {
  console.log(`   ${titulo}: ${dif.length} equipe(s) diferente(s)`);
  for (const x of dif.slice(0, 15)) {
    console.log(`     ${x.equipe.padEnd(12)} ${String(x.a).padStart(4)} → ${String(x.b).padStart(4)}  (${x.dif > 0 ? '+' : ''}${x.dif})`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const semRede = args.includes('--sem-rede');
  const datas = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!datas.length) {
    console.error('✖ Uso: node scripts/diag-paridade-backfill.js <de> [<ate>] [--sem-rede]');
    process.exit(1);
  }
  const de = datas[0], ate = datas[1] || datas[0];
  const limite = addDias(hojeBRT(), -3);
  if (ate > limite) {
    console.error(`✖ ${ate} ainda não está fechado: a régua precisa de D+2 completo. Último dia aceito: ${limite}.`);
    process.exit(1);
  }

  const dias = [];
  for (let d = de; d <= ate; d = addDias(d, 1)) dias.push(d);
  console.log(`\n🔎 Paridade backfill × ao vivo · ${de} → ${ate} (${dias.length} dia(s)) · régua = passe de D+1 · read-only`);

  const backfill = new Map();   // data → linhas de snapshot
  for (let d = de; d <= addDias(ate, 2); d = addDias(d, 1)) backfill.set(d, await backfillDoDia(d, semRede));

  const relatorio = [];
  for (const dia of dias) {
    const janelaDatas = [dia, addDias(dia, 1), addDias(dia, 2)];
    const doBanco = await snapshotsDoBanco(janelaDatas);
    const aoVivo = doBanco.filter(r => !ehSnapshotDeBackfill(r));
    const deBackfillNoBanco = doBanco.length - aoVivo.length;
    const soBackfill = janelaDatas.flatMap(d => backfill.get(d));
    const janelas = [...snapshotsDasJanelas(aoVivo), ...soBackfill];

    const tabela = await tabelaPorEquipe(dia);
    const vivo = await dryRun(dia, aoVivo);
    const back = await dryRun(dia, soBackfill);
    const jan = await dryRun(dia, janelas);

    console.log(`\n── ${dia} ──`);
    console.log(`   snapshots ao vivo: ${aoVivo.length} linhas (${deBackfillNoBanco} de backfill antigo no banco, fora da conta)`);
    console.log(`   TABELA ${soma(tabela)} · AO VIVO ${soma(vivo)} · BACKFILL ${soma(back)} · JANELAS ${soma(jan)}`);
    imprimirDif('AO VIVO → BACKFILL', difPorEquipe(vivo, back));
    imprimirDif('AO VIVO → JANELAS ', difPorEquipe(vivo, jan));

    const cVivo = concluidasPorEquipe(aoVivo, dia);
    const cBack = concluidasPorEquipe(soBackfill, dia);
    const soVivo = soEmUm(cVivo, cBack);
    const soBack = soEmUm(cBack, cVivo);
    console.log(`   concluídas só no ao vivo: ${soVivo.length} · só no backfill: ${soBack.length} (antes da regra rejeitada > concluída)`);
    for (const n of soVivo.slice(0, AMOSTRA)) console.log(`     só ao vivo   ${n.equipe} ${n.codigo} ${n.tipo} conclusão=${n.conclusao}`);
    for (const n of soBack.slice(0, AMOSTRA)) console.log(`     só backfill  ${n.equipe} ${n.codigo} ${n.tipo} conclusão=${n.conclusao}`);

    const lg = compararLogon(logonLogoff(aoVivo, dia), logonLogoff(soBackfill, dia));
    console.log(`   logon/logoff (±${TOL_LOGON_MIN} min): ${lg.equipes} equipes nos dois · logon igual ${lg.logonIgual} · logoff igual ${lg.logoffIgual}` +
      ` · só ao vivo ${lg.soAoVivo.length} · só backfill ${lg.soBackfill.length}`);
    for (const x of lg.logonDif.slice(0, 5)) console.log(`     logon  ${x.equipe}: ao vivo ${x.aoVivo} × backfill ${x.backfill} (${x.min ?? '?'} min)`);
    for (const x of lg.logoffDif.slice(0, 5)) console.log(`     logoff ${x.equipe}: ao vivo ${x.aoVivo} × backfill ${x.backfill} (${x.min ?? '?'} min)`);

    relatorio.push({
      dia, totais: { tabela: soma(tabela), aoVivo: soma(vivo), backfill: soma(back), janelas: soma(jan) },
      difBackfill: difPorEquipe(vivo, back), difJanelas: difPorEquipe(vivo, jan),
      concluidasSoAoVivo: soVivo, concluidasSoBackfill: soBack, logon: lg,
    });
  }

  const saida = path.join(__dirname, '..', 'logs', `paridade-${de}-${ate}.json`);
  fs.writeFileSync(saida, JSON.stringify(relatorio, null, 2));
  console.log(`\n   detalhe completo: ${saida}`);
  console.log(`   requisições à EDP nesta execução: ${resumo().total}\n`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error('✖', err.code ? `[${err.code}]` : '', err.message);
    process.exit(1);
  });
}

module.exports = {
  ehSnapshotDeBackfill, snapshotsDasJanelas, comoSnapshots, porEquipe, difPorEquipe,
  concluidasPorEquipe, soEmUm, logonLogoff, compararLogon, addDias,
};
