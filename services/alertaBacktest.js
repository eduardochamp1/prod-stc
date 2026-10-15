/**
 * services/alertaBacktest.js
 *
 * Núcleo PURO do backtest do alerta de baixa produtividade (T8 do PLAN de
 * 14/10/2026). Sem banco, sem WPA: o script scripts/backtest-alerta-produtividade.js
 * faz o I/O e chama estas funções.
 *
 * Pergunta que o backtest responde ANTES de o José ligar o alerta: "se a regra
 * estivesse ligada nos últimos 30 dias, quantas equipes teriam alertado por dia?"
 * Se for uma fração alta e constante, o limite ou a regra estão errados — e a
 * gente descobre sem incomodar ninguém.
 *
 * REGRA ÚNICA: a simulação chama `avaliarEquipe` do alerta real em cada ciclo de
 * 15 min. Nunca reimplementa a regra aqui — senão o backtest mediria uma regra
 * diferente da que vai pra produção.
 *
 * LIMITES CONHECIDOS (o script os imprime):
 *   - a escala usada é a ATUAL da equipe (equipes_oficiais), não a do dia;
 *   - o estado vem dos snapshots (último até o horário do ciclo); o ciclo real
 *     lê team_daily_totals, que aplica o ajuste de `_notaDate` (nota concluída em
 *     dia anterior sai da conta). Aqui esse ajuste não existe, então `executadas`
 *     pode vir um pouco ALTO e o backtest, um pouco BAIXO em alertas;
 *   - a refeição vem de sessao_intervalo, sincronizada às 03:10 de D+1. Só existe
 *     de D-1 pra trás, e o `inicio/fim` tem o defeito de fuso do P1-48 (o script
 *     lê com AT TIME ZONE 'UTC' pra desfazer o 'Z' errado).
 */

'use strict';

const { avaliarEquipe, minutosDeHM } = require('./alertaProdutividade');
const { instanteBRT, dateBRT, minutosBRT } = require('./timeUtil');

const PASSO_CICLO_MIN = 15;   // o runSnapshot roda em */15 (cronService.js:1469)

/** Minutos dos ciclos de 15 min a partir do meio do turno, antes do fim. */
function ciclosDoDia(meioMin, fimMin, passo = PASSO_CICLO_MIN) {
  if (!Number.isFinite(meioMin) || !Number.isFinite(fimMin) || meioMin >= fimMin) return [];
  const out = [];
  for (let m = Math.ceil(meioMin / passo) * passo; m < fimMin; m += passo) out.push(m);
  return out;
}

/**
 * Estado de uma equipe num instante, a partir dos snapshots do dia.
 * @param {Array<{capturedAtMs:number, sessionEnd:*, conc:string[], rej:string[]}>} snaps
 * @param {number} instanteMs
 * @returns {{executadas:number, rejeitadas:number, sessaoAberta:boolean}|null}
 *   null = nenhum snapshot até o instante (equipe ainda não tinha logado)
 */
function estadoEm(snaps, instanteMs) {
  const ate = (snaps || []).filter(s => s.capturedAtMs <= instanteMs)
    .sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  if (ate.length === 0) return null;
  // UNIÃO por id: o mesmo UUID aparece em vários snapshots e sessões (relogin).
  const conc = new Set();
  const rej = new Set();
  for (const s of ate) {
    for (const id of (s.conc || [])) if (id) conc.add(id);
    for (const id of (s.rej || [])) if (id) rej.add(id);
  }
  // rejeitada > concluída (20/07/2026): nota nas duas listas conta só como rejeitada.
  let executadas = 0;
  for (const id of conc) if (!rej.has(id)) executadas++;
  const ultimo = ate[ate.length - 1];
  return { executadas, rejeitadas: rej.size, sessaoAberta: !ultimo.sessionEnd };
}

/** Instante (ms) → hora de PAREDE BRT 'YYYY-MM-DDTHH:MM:SS'. */
function paredeBRT(ms) {
  const min = minutosBRT(ms);
  const ss = Math.floor(ms / 1000) % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${dateBRT(ms)}T${p(Math.floor(min / 60))}:${p(min % 60)}:${p(ss)}`;
}

/**
 * Havia intervalo de refeição cobrindo a hora de parede `parede`?
 * `inicio`/`fim` em hora de parede BRT ('YYYY-MM-DDTHH:MM:SS'); fim nulo = em aberto;
 * fim EXCLUSIVO. Comparação de string funciona porque o formato é ordenável.
 */
function emRefeicaoEm(intervalos, parede) {
  if (!Array.isArray(intervalos)) return false;
  return intervalos.some(i => i && /refei/i.test(String(i.motivo || ''))
    && i.inicio <= parede && (i.fim === null || i.fim === undefined || i.fim > parede));
}

/**
 * Simula UMA equipe em UM dia, ciclo a ciclo, com a regra real.
 * @returns {{resultado:'alertaria'|'nao_alertaria'|'ignorada', motivo?:string,
 *   cicloMin?:number, executadasNoMeio?:number, executadasNoCiclo?:number,
 *   executadasFimDia?:number, resolveuDepois?:boolean}}
 */
function simularEquipeDia({ data, categoria, escala, config, comRefeicao, intervalos, snaps }) {
  const base = {
    config, escala, executadas: 0, rejeitadas: 0, sessaoAberta: true, ehReal: true,
    categoria, aberto: false, resolvido: false, emRefeicao: false,
  };
  // Pré-checagem de elegibilidade pela PRÓPRIA regra (categoria, escala, vira-noite).
  const pre = avaliarEquipe({ ...base, agoraMin: 0 });
  if (pre.estado === 'ignorar') return { resultado: 'ignorada', motivo: pre.motivo };
  if (pre.motivo === 'categoria_fora') return { resultado: 'ignorada', motivo: 'categoria_fora' };

  const ini = minutosDeHM(escala.inicio);
  const fim = minutosDeHM(escala.fim);
  const meio = Math.floor((ini + fim) / 2);
  const ciclos = ciclosDoDia(meio, fim);

  // Tem que estar logada, com sessão aberta, no PRIMEIRO ciclo (o meio do turno).
  const noMeio = ciclos.length ? estadoEm(snaps, instanteBRT(data, ciclos[0])) : null;
  if (!noMeio || !noMeio.sessaoAberta) return { resultado: 'ignorada', motivo: 'sem_sessao_no_meio' };

  let alerta = null;
  for (const c of ciclos) {
    const t = instanteBRT(data, c);
    const st = estadoEm(snaps, t);
    if (!st || !st.sessaoAberta) break;              // sessão encerrou: para
    const dec = avaliarEquipe({
      ...base, agoraMin: c, executadas: st.executadas, rejeitadas: st.rejeitadas,
      emRefeicao: comRefeicao ? emRefeicaoEm(intervalos, paredeBRT(t)) : false,
    });
    if (dec.estado === 'abrir') { alerta = { cicloMin: c, executadasNoCiclo: st.executadas }; break; }
  }

  if (!alerta) return { resultado: 'nao_alertaria', executadasNoMeio: noMeio.executadas };
  const fimDia = estadoEm(snaps, instanteBRT(data, 23 * 60 + 59));
  const executadasFimDia = fimDia ? fimDia.executadas : alerta.executadasNoCiclo;
  return {
    resultado: 'alertaria', ...alerta, executadasNoMeio: noMeio.executadas,
    executadasFimDia, resolveuDepois: executadasFimDia >= config.limite,
  };
}

const _pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/**
 * Resume os resultados da simulação (uma linha por equipe/dia).
 * `ignorada` fica FORA do denominador e é contada à parte por motivo.
 */
function resumir(resultados) {
  const porDC = new Map();
  const porDia = new Map();
  const ignoradas = {};
  const distribuicao = { 0: 0, 1: 0, 2: 0, 3: 0, '4+': 0 };
  const total = { avaliadas: 0, alertariam: 0, pct: 0, resolveramDepois: 0 };

  for (const r of resultados) {
    if (r.resultado === 'ignorada') {
      if (r.motivo === 'categoria_fora') continue;      // ruído: nunca esteve no escopo
      const g = ignoradas[r.motivo] || (ignoradas[r.motivo] = { ocorrencias: 0, equipes: [] });
      g.ocorrencias++;
      if (r.equipe && !g.equipes.includes(r.equipe)) g.equipes.push(r.equipe);
      continue;
    }
    const alertou = r.resultado === 'alertaria';
    const k = `${r.data}|${r.categoria}`;
    const dc = porDC.get(k) || { data: r.data, categoria: r.categoria, avaliadas: 0, alertariam: 0 };
    dc.avaliadas++; if (alertou) dc.alertariam++;
    porDC.set(k, dc);
    const d = porDia.get(r.data) || { avaliadas: 0, alertariam: 0 };
    d.avaliadas++; if (alertou) d.alertariam++;
    porDia.set(r.data, d);

    total.avaliadas++;
    if (alertou) { total.alertariam++; if (r.resolveuDepois) total.resolveramDepois++; }
    const n = Number(r.executadasNoMeio) || 0;
    distribuicao[n >= 4 ? '4+' : n]++;
  }
  total.pct = _pct(total.alertariam, total.avaliadas);
  for (const g of Object.values(ignoradas)) g.equipes.sort();

  const porDiaCategoria = [...porDC.values()]
    .map(x => ({ ...x, pct: _pct(x.alertariam, x.avaliadas) }))
    .sort((a, b) => a.data.localeCompare(b.data) || a.categoria.localeCompare(b.categoria));
  const pcts = [...porDia.values()].map(d => _pct(d.alertariam, d.avaliadas));
  const mediaPctDiaria = pcts.length ? Math.round((pcts.reduce((s, v) => s + v, 0) / pcts.length) * 10) / 10 : 0;

  return { porDiaCategoria, total, mediaPctDiaria, distribuicao, ignoradas };
}

/** Frase de apoio à leitura. NÃO decide: quem decide é o José. */
function veredito(pctMedio) {
  if (pctMedio === null || pctMedio === undefined || Number.isNaN(pctMedio)) return 'sem dados para avaliar';
  if (pctMedio < 10) return `razoável: em média ${pctMedio}% das equipes avaliadas alertariam por dia`;
  if (pctMedio < 25) return `atenção: em média ${pctMedio}% alertariam por dia — veja se o limite ou a categoria estão certos`;
  return `NÃO LIGAR como está: em média ${pctMedio}% das equipes alertariam por dia — a regra viraria ruído`;
}

/** Linhas do banco → Map(equipe → snapshots ordenados), no formato da simulação. */
function montarSnapsPorEquipe(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const ts = r.captured_at instanceof Date ? r.captured_at.getTime() : Date.parse(r.captured_at);
    if (!Number.isFinite(ts)) continue;
    if (!m.has(r.team_name)) m.set(r.team_name, []);
    m.get(r.team_name).push({
      capturedAtMs: ts,
      sessionEnd: r.session_end || null,
      conc: Array.isArray(r.conc) ? r.conc : [],
      rej: Array.isArray(r.rej) ? r.rej : [],
    });
  }
  for (const lista of m.values()) lista.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  return m;
}

module.exports = {
  PASSO_CICLO_MIN, ciclosDoDia, estadoEm, paredeBRT, emRefeicaoEm,
  simularEquipeDia, resumir, veredito, montarSnapsPorEquipe,
};
