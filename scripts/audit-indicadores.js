#!/usr/bin/env node
/**
 * scripts/audit-indicadores.js
 * AUDITORIA DE VERACIDADE dos 3 indicadores questionados: EXECUTADAS,
 * EM ANDAMENTO e REJEITADAS.
 *
 * Método: compara, equipe a equipe e POR UUID de nota, duas fontes
 * independentes para o dia de HOJE:
 *
 *   WPA AO VIVO (verdade)                     PAINEL (o que exibimos)
 *   ──────────────────────                    ─────────────────────────
 *   /api/Sessions/today       → sessões       último snapshot de hoje
 *   /api/teamsstatus/V2       → Concluded[],  (data->notasConcluidas/
 *                                Downloaded[]   Executadas/Rejeitadas)
 *   /api/notes/rejected/{s}/session           ∪ note_rejections (tabela)
 *   /api/notes/executed/{s}/session
 *
 * Regras de bucket idênticas às do painel (cada UUID em 1 só estado):
 *   REJEITADAS  = rejected (∪ sessões do dia)
 *   EXECUTADAS  = Concluded − rejeitadas          (rejeitada > concluída)
 *   ANDAMENTO   = (executed ∪ Downloaded 3/6/7) − concluídas − rejeitadas
 *
 * REGRA DE NEGÓCIO confirmada pelo José (22/07/2026, tela Gestão Online):
 * "as notas que temos que contar como rejeitadas são as que aparecem com
 * status de execução Rejeitada". O portal distingue rejeitada por um CAMPO
 * da nota dentro da lista Concluídas; nosso painel distingue pela presença
 * no endpoint notes/rejected. Esta auditoria também CONFRONTA as duas
 * definições (campo × endpoint) pra provar que são equivalentes — e coleta
 * empiricamente os campos de status brutos (ExecutionStatus/ConclusionStatus/
 * Status) de cada bucket, já que normalizarNotaV2 descarta ConclusionStatus.
 *
 * READ-ONLY: só GETs na WPA (mesma carga de 1 ciclo do cron) e SELECTs no
 * Postgres local. Não escreve nada. Rodar na VM:
 *
 *   cd ~/prod-stc && node scripts/audit-indicadores.js
 *   cd ~/prod-stc && node scripts/audit-indicadores.js --so-diferencas
 */

require('dotenv').config({ override: true });

const { wpaFetch, getSessions } = require('../services/wpaService');
const { isOficial } = require('../services/equipesOficiais');
const { dateBRT } = require('../services/timeUtil');

const SECTORS = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
const ENGELMIG_COMPANY_ID = process.env.WPA_COMPANY_ID
  || '92a2f98e-8877-433e-8358-173b94c13a54';

const SO_DIFF = process.argv.includes('--so-diferencas');

let pool;
try {
  pool = require('../services/pgShim')._getPool();
} catch (err) {
  console.error('[audit] sem pool Postgres:', err.message);
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ExecutionStatus → bucket (mesmo mapa do normalizarNotaV2)
const ES_ANDAMENTO = new Set([3, 6, 7]);

// ── WPA ao vivo ──────────────────────────────────────────────────────────────

async function fetchNotesSession(sessionId, status) {
  try {
    const r = await wpaFetch(`/api/notes/${status}/${sessionId}/session`);
    if (!r.ok) return { ok: false, status: r.status, notes: [] };
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.Data || []);
    return { ok: true, notes: Array.isArray(arr) ? arr : [] };
  } catch (e) {
    return { ok: false, err: e.message, notes: [] };
  }
}

async function getV2(sector) {
  try {
    const r = await wpaFetch(`/api/teamsstatus/V2?sectorId=${sector}&filterByExhibitionSector=true`);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : (j.Data || []);
  } catch { return []; }
}

// Tally global dos campos de status brutos por origem (Concluded/rejected/executed)
// — vocabulário empírico pra mapear o "Status de execução" do portal.
const statusCombos = new Map();
function tallyStatus(origem, n) {
  const key = `${origem} | ExecutionStatus=${n.ExecutionStatus ?? '—'} | ConclusionStatus=${n.ConclusionStatus ?? '—'} | Status=${n.Status ?? '—'}`;
  statusCombos.set(key, (statusCombos.get(key) || 0) + 1);
}
// "Rejeitada" pelo CAMPO da nota (regra de negócio do portal): qualquer campo
// de status textual contendo 'rejeit'.
function ehRejeitadaPorCampo(n) {
  return /rejeit/i.test(String(n.ConclusionStatus ?? '')) || /rejeit/i.test(String(n.Status ?? ''));
}

async function coletaWpa() {
  // teamName → { sector, sessions:[{id,end}], conc:Set, exec:Set, rej:Set,
  //              concRejPorCampo:Set, downAndamento:Set, v2Online:bool, numeroPorId:Map }
  const teams = new Map();

  for (const sector of SECTORS) {
    let sessions = [];
    try { sessions = await getSessions(sector); }
    catch (e) { console.error(`  [${sector}] Sessions/today falhou: ${e.message}`); continue; }

    const engel = sessions.filter(s => s?.Team?.CompanyId === ENGELMIG_COMPANY_ID);
    console.log(`  [${sector}] sessões hoje: ${sessions.length} (${engel.length} Engelmig)`);

    for (const s of engel) {
      const name = (s.Team?.Name || '').trim();
      if (!name) continue;
      if (!teams.has(name)) {
        teams.set(name, {
          sector, sessions: [], conc: new Set(), exec: new Set(), rej: new Set(),
          concRejPorCampo: new Set(),
          downAndamento: new Set(), v2Online: false, numeroPorId: new Map(),
          fetchErros: 0,
        });
      }
      teams.get(name).sessions.push({ id: s.Id, end: s.EndTime || null });
    }

    // V2 (1 chamada por setor): Concluded + Downloaded por equipe
    const v2 = await getV2(sector);
    const idx = new Map();
    v2.forEach(item => {
      const nome = (item.Session?.Team?.Name || '').trim();
      if (nome) idx.set(nome, item);
    });
    for (const [name, t] of teams) {
      if (t.sector !== sector) continue;
      const item = idx.get(name);
      if (!item) continue;
      t.v2Online = true;
      (item.Concluded || []).forEach(n => {
        if (n?.Id) {
          t.conc.add(n.Id);
          t.numeroPorId.set(n.Id, `${n.Number || ''}/${n.Type || ''}`);
          tallyStatus('Concluded[]', n);
          if (ehRejeitadaPorCampo(n)) t.concRejPorCampo.add(n.Id);
        }
      });
      (item.Downloaded || []).forEach(n => {
        if (n?.Id && ES_ANDAMENTO.has(n.ExecutionStatus)) {
          t.downAndamento.add(n.Id);
          t.numeroPorId.set(n.Id, `${n.Number || ''}/${n.Type || ''}`);
        }
      });
    }
  }

  // rejected + executed por sessão (concorrência 3, gentil com a EDP)
  const jobs = [];
  for (const [name, t] of teams) {
    for (const sess of t.sessions) {
      if (!sess.id) continue;
      jobs.push({ name, t, sessId: sess.id });
    }
  }
  console.log(`  buscando rejected+executed de ${jobs.length} sessão(ões)…`);
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      const [rej, exec] = await Promise.all([
        fetchNotesSession(job.sessId, 'rejected'),
        fetchNotesSession(job.sessId, 'executed'),
      ]);
      if (!rej.ok || !exec.ok) job.t.fetchErros++;
      rej.notes.forEach(n => { if (n?.Id) { job.t.rej.add(n.Id); job.t.numeroPorId.set(n.Id, `${n.Number || ''}/${n.Type || ''}`); tallyStatus('notes/rejected', n); } });
      exec.notes.forEach(n => { if (n?.Id) { job.t.exec.add(n.Id); job.t.numeroPorId.set(n.Id, `${n.Number || ''}/${n.Type || ''}`); tallyStatus('notes/executed', n); } });
      await sleep(150);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return teams;
}

// ── Painel (último snapshot + note_rejections) ───────────────────────────────

async function coletaPainel(hoje) {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (team_name) team_name, regional, session_end,
           to_char(captured_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS snap_hora,
           EXTRACT(EPOCH FROM (now() - captured_at))/60 AS snap_idade_min,
           coalesce(data->'notasConcluidas','[]'::jsonb)  AS conc,
           coalesce(data->'notasExecutadas','[]'::jsonb)  AS exec,
           coalesce(data->'notasRejeitadas','[]'::jsonb)  AS rej
    FROM snapshots WHERE date = $1
    ORDER BY team_name, captured_at DESC`, [hoje]);

  const rejPersist = await pool.query(
    `SELECT team_name, note_id FROM note_rejections WHERE session_date = $1`, [hoje]);
  const rejByTeam = new Map();
  rejPersist.rows.forEach(r => {
    if (!rejByTeam.has(r.team_name)) rejByTeam.set(r.team_name, new Set());
    rejByTeam.get(r.team_name).add(r.note_id);
  });

  const painel = new Map();
  for (const r of rows) {
    const ids = (arr) => new Set((arr || []).map(n => n && n.id).filter(Boolean));
    const conc = ids(r.conc), exec = ids(r.exec);
    const rej = ids(r.rej);
    (rejByTeam.get(r.team_name) || []).forEach(id => rej.add(id));
    painel.set(r.team_name, {
      regional: r.regional, snapHora: r.snap_hora,
      snapIdadeMin: Math.round(r.snap_idade_min),
      sessaoAberta: !r.session_end,
      conc, exec, rej,
    });
  }
  return painel;
}

// ── Regras de bucket (idênticas ao card) ─────────────────────────────────────

function buckets({ conc, exec, rej }) {
  const executadas = new Set([...conc].filter(id => !rej.has(id)));
  const andamento  = new Set([...exec].filter(id => !conc.has(id) && !rej.has(id)));
  return { executadas, andamento, rejeitadas: rej };
}

function diffSets(a, b) {
  const soA = [...a].filter(x => !b.has(x));
  const soB = [...b].filter(x => !a.has(x));
  return { soA, soB, igual: soA.length === 0 && soB.length === 0 };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const hoje = dateBRT();
  console.log(`\n${'═'.repeat(74)}`);
  console.log(`  AUDITORIA DE VERACIDADE — EXECUTADAS / EM ANDAMENTO / REJEITADAS`);
  console.log(`  ${hoje} (BRT) · WPA ao vivo × painel (último snapshot + note_rejections)`);
  console.log('═'.repeat(74));

  console.log('\n▶ Coletando da WPA (fonte independente)…');
  const wpa = await coletaWpa();
  console.log(`  equipes Engelmig com sessão hoje: ${wpa.size}`);

  console.log('\n▶ Lendo o lado do painel (Postgres)…');
  const painel = await coletaPainel(hoje);
  console.log(`  equipes no snapshot de hoje: ${painel.size}`);

  const todas = new Set([...wpa.keys(), ...painel.keys()]);
  let iguais = 0, difere = 0, soWpa = 0, soPainel = 0;
  const totais = {
    wpa:    { executadas: 0, andamento: 0, rejeitadas: 0 },
    painel: { executadas: 0, andamento: 0, rejeitadas: 0 },
  };
  const detalhes = [];

  for (const name of [...todas].sort()) {
    const w = wpa.get(name);
    const p = painel.get(name);
    const oficial = isOficial(name) ? '' : '  [NÃO-OFICIAL: fora do painel]';

    if (w && !p) { soWpa++; detalhes.push(`  ⚠️  ${name}: só na WPA (sem snapshot hoje)${oficial}`); continue; }
    if (!w && p) {
      soPainel++;
      if (p.sessaoAberta) detalhes.push(`  ⚠️  ${name}: só no painel (sessão aberta sem sessão WPA hoje?)${oficial}`);
      continue;
    }

    // Sessão encerrada (V2 offline): notes/executed retorna as CONCLUÍDAS da
    // sessão (cookbook: fluxo histórico), não "em andamento". Sem este ajuste,
    // toda equipe deslogada virava exec=0/andamento=N no lado WPA — artefato do
    // método, não erro do painel (visto na rodada de 22/07: ECLSJ80, EPCIT30…).
    const wpaConc = w.v2Online ? w.conc : new Set([...w.conc, ...w.exec]);
    const wpaExec = w.v2Online ? new Set([...w.exec, ...w.downAndamento]) : new Set(w.downAndamento);
    const bw = buckets({ conc: wpaConc, exec: wpaExec, rej: w.rej });
    const bp = buckets(p);

    ['executadas', 'andamento', 'rejeitadas'].forEach(k => {
      totais.wpa[k] += bw[k].size;
      totais.painel[k] += bp[k].size;
    });

    const dE = diffSets(bw.executadas, bp.executadas);
    const dA = diffSets(bw.andamento,  bp.andamento);
    const dR = diffSets(bw.rejeitadas, bp.rejeitadas);
    // NOTA (descoberta na rodada de 22/07/2026): o confronto "rejeitada por
    // CAMPO × por ENDPOINT" foi removido — os payloads de lista NÃO trazem o
    // "Status de execução" (Executada/Rejeitada) como texto. ConclusionStatus
    // ali é PONTUALIDADE ('ok'|'late' vs Conclusão Desejada) e Status é código
    // numérico. A distinção rejeitada vem mesmo do endpoint notes/rejected +
    // note_rejections (que é AUTORITATIVA: o endpoint PODA rejeições antigas
    // após ~horas — provado com ECGPR51 22/07: notas 015001784811/015001785127
    // exibidas "Rejeitada" no portal às 14:51 e ausentes do endpoint às 15:12).

    if (dE.igual && dA.igual && dR.igual) {
      iguais++;
      if (!SO_DIFF) detalhes.push(
        `  ✅ ${name}: exec ${bw.executadas.size} · and ${bw.andamento.size} · rej ${bw.rejeitadas.size}  (bate por UUID)${oficial}`);
      continue;
    }

    difere++;
    const num = (t, id) => t.numeroPorId.get(id) || id.slice(0, 8);
    const fmt = (d, t) => {
      const parts = [];
      if (d.soA.length) parts.push(`WPA+${d.soA.length} [${d.soA.slice(0, 3).map(id => num(t, id)).join(', ')}${d.soA.length > 3 ? '…' : ''}]`);
      if (d.soB.length) parts.push(`painel+${d.soB.length} [${d.soB.slice(0, 3).map(id => num(t, id)).join(', ')}${d.soB.length > 3 ? '…' : ''}]`);
      return parts.join(' ');
    };
    detalhes.push(`  🔴 ${name}${oficial}  (snap ${p.snapHora}, ${p.snapIdadeMin}min atrás${w.v2Online ? '' : '; V2 offline — Concluded indisponível ao vivo'}${w.fetchErros ? `; ${w.fetchErros} fetch(es) falharam` : ''})`);
    if (!dE.igual) detalhes.push(`       EXECUTADAS  wpa=${bw.executadas.size} painel=${bp.executadas.size}  ${fmt(dE, w)}`);
    if (!dA.igual) detalhes.push(`       ANDAMENTO   wpa=${bw.andamento.size} painel=${bp.andamento.size}  ${fmt(dA, w)}`);
    if (!dR.igual) detalhes.push(`       REJEITADAS  wpa=${bw.rejeitadas.size} painel=${bp.rejeitadas.size}  ${fmt(dR, w)}`);
    // painel com MAIS rejeitadas que a WPA ao vivo geralmente = poda do endpoint
    // (rejeições antigas somem após ~horas; note_rejections preserva) — painel certo.
    if (!dR.igual && dR.soB.length > 0 && dR.soA.length === 0) detalhes.push(
      `       ↳ provável PODA do endpoint (rejeições antigas) — note_rejections preserva; painel confere com o portal`);
  }

  console.log('\n▶ Comparação por equipe (por UUID):\n');
  detalhes.forEach(l => console.log(l));

  console.log(`\n${'═'.repeat(74)}`);
  console.log('  RESUMO');
  console.log('═'.repeat(74));
  console.log(`  equipes comparadas: ${iguais + difere}  |  batem 100%: ${iguais}  |  divergem: ${difere}`);
  console.log(`  só na WPA: ${soWpa}  |  só no painel: ${soPainel}`);
  console.log('');
  console.log('  TOTAIS            WPA(vivo)   PAINEL     Δ');
  ['executadas', 'andamento', 'rejeitadas'].forEach(k => {
    const a = totais.wpa[k], b = totais.painel[k];
    console.log(`  ${k.toUpperCase().padEnd(14)} ${String(a).padStart(8)}  ${String(b).padStart(8)}  ${String(b - a).padStart(5)}`);
  });
  console.log('');
  console.log('  VOCABULÁRIO DE STATUS OBSERVADO (campos brutos por origem):');
  [...statusCombos.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
    console.log(`    ${String(n).padStart(5)}×  ${k}`);
  });
  console.log('');
  console.log('  ↑ Vocabulário decodificado (22/07/2026): ConclusionStatus = PONTUALIDADE');
  console.log('  (ok=no prazo, late=fora da Conclusão Desejada); Status é código numérico.');
  console.log('  O "Status de execução" (Executada/Rejeitada) do portal NÃO vem nas listas —');
  console.log('  a distinção é dada pelo endpoint notes/rejected + note_rejections (autoritativa;');
  console.log('  o endpoint PODA rejeições antigas após ~horas).');
  console.log('');
  console.log('  Leitura: Δ pequeno + divergências explicadas por timing (snapshot de');
  console.log('  até 15min atrás; nota concluída/rejeitada nesse intervalo) = painel');
  console.log('  VERAZ. Divergência persistente na mesma equipe = investigar o UUID');
  console.log('  listado. Equipes com "V2 offline": Concluded ao vivo indisponível');
  console.log('  (sessão encerrada) — compare só ANDAMENTO/REJEITADAS nessas.');
  console.log('  Cole esta saída no chat pra interpretação.\n');
}

main()
  .catch(err => { console.error('\n[audit] erro fatal:', err.message); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch (_) {} });
