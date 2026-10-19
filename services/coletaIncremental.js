/**
 * services/coletaIncremental.js
 * Memória por SESSÃO da coleta ao vivo, para não pedir à EDP o que não muda mais.
 *
 * ⚠️ POR QUE EXISTE (19/10/2026, backlog P0-11 itens 3 e 5): a EDP questionou o
 * volume de requisições. Toda sessão JÁ ENCERRADA do dia era rebuscada a cada
 * ciclo de 15 min até 23h45 — `notes/rejected` + `notes/executed` +
 * `collaborators/{id}/session` (sessão fechada não está no V2) — ~3 requisições
 * por sessão por ciclo, por dado que não muda mais (estimado em ~6 mil/dia).
 *
 * Três peças, com riscos diferentes:
 *
 *  (3a) COLABORADORES de sessão encerrada — buscados 1 vez e guardados. Risco
 *       zero: a lista de quem estava na sessão não muda depois que ela fechou.
 *
 *  (3b) NOTAS de sessão encerrada — rebuscadas DE HORA EM HORA, não a cada
 *       ciclo de 15 min (`WPA_ENCERRADA_REBUSCA_MIN`, default 60; 0 = todo
 *       ciclo, como era antes). Nos ciclos a partir das 23h BRT a rebusca é
 *       OBRIGATÓRIA: o último snapshot do dia (23h45), que a consolidação das
 *       23h50 lê, sai sempre com o dado fresco. Entre uma rebusca e outra, o
 *       painel mostra a última busca bem-sucedida — até ~45 min de atraso para
 *       equipe já deslogada, aceito pelo José em 19/10/2026.
 *       Se a rebusca FALHA e há memória, o bucket usa a memória em vez do []
 *       que o _safeNotes devolvia (vazio de falha não é "sem produção").
 *       Só guarda na memória com as DUAS buscas bem-sucedidas.
 *
 *       ⚠️ HISTÓRICO (19/10/2026): a 1ª versão desta peça CONGELAVA as notas
 *       depois de uma janela (`WPA_ENCERRADA_CONGELA_MIN`). O
 *       scripts/diag-sessao-encerrada.js (v2), rodado na VM sobre 14 dias de
 *       snapshots, derrubou a ideia: 623 de 1535 sessões encerradas (40,6%)
 *       MUDAM depois de encerradas — 270 ganham executada, 249 ganham
 *       rejeitada — até 21h depois. Congelar perderia produção e a rejeição que
 *       a regra rejeitada>concluída usa. Rebuscar com menos frequência não perde
 *       nada no fechamento do dia; congelar perdia.
 *
 *  (5)  SINAL DO V2 para sessão ATIVA — só em MODO SOMBRA: nada deixa de ser
 *       buscado. Mede quantas vezes "o V2 não mudou" teria permitido pular a
 *       busca de notas (`pularia`), e quantas vezes as notas mudaram MESMO ASSIM
 *       (`divergiu` — o que se perderia). Os números vão para
 *       /api/admin/wpa-requisicoes. Ligar de verdade é decisão posterior, com
 *       `divergiu = 0` medido por dias (regra 7 do CLAUDE.md: número reportado à
 *       EDP não se arrisca por economia).
 *
 * Estado de PROCESSO (PM2 instances=1, regra 8). Restart zera: a sessão volta a
 * ser buscada no ciclo seguinte — mais requisições, nunca dado a menos. As
 * memórias são zeradas na virada do dia BRT.
 */

'use strict';

const { dateBRT, hourBRT } = require('./timeUtil');

/** Relógio do módulo — trocável em teste (a rebusca obrigatória depende da hora BRT). */
const relogio = { agora: () => Date.now() };

const REBUSCA_MIN_PADRAO = 60;
/** A partir desta hora BRT, toda sessão encerrada é rebuscada em todo ciclo. */
const HORA_REBUSCA_OBRIGATORIA = 23;
/**
 * Folga: o ciclo de 15 min não cai no mesmo segundo. Sem ela, a busca de
 * 60 min atrás feita 2 s mais tarde passaria por "59:58 < 60" e a rebusca
 * escorregaria para o ciclo seguinte (75 min de atraso).
 */
const FOLGA_MS = 5 * 60_000;

/** Intervalo de rebusca da sessão encerrada, em ms. 0 = todo ciclo. */
function rebuscaMsDoEnv() {
  const raw = process.env.WPA_ENCERRADA_REBUSCA_MIN;
  if (raw === undefined || raw === '') return REBUSCA_MIN_PADRAO * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : REBUSCA_MIN_PADRAO * 60_000;
}

// ── memórias, zeradas na virada do dia ──────────────────────────────────────

function criarMemoria() {
  const m = { dia: null, encerradas: new Map(), sombra: new Map(),
              contSombra: { comparadas: 0, pularia: 0, divergiu: 0, exemplos: [] } };
  m.garantirDia = (agora = relogio.agora()) => {
    const d = dateBRT(agora);
    if (m.dia !== d) {
      m.dia = d;
      m.encerradas.clear();
      m.sombra.clear();
      m.contSombra = { comparadas: 0, pularia: 0, divergiu: 0, exemplos: [] };
    }
  };
  return m;
}

// ── (3a) + (3b) sessão encerrada ────────────────────────────────────────────

/** Registro da sessão encerrada; cria na 1ª vez que é vista encerrada. */
function registroEncerrada(mem, sessionId, agora = relogio.agora()) {
  mem.garantirDia(agora);
  let r = mem.encerradas.get(sessionId);
  if (!r) {
    r = { vistaEncerradaEm: agora, colaboradores: null, notas: null };
    mem.encerradas.set(sessionId, r);
  }
  return r;
}

/**
 * Sessão vista ABERTA de novo (reabriu): esquece o registro de encerrada — ao
 * fechar outra vez, é buscada na hora. A memória da sombra (aberta) fica — é
 * ela que compara um ciclo com o anterior.
 */
function esquecerEncerrada(mem, sessionId) {
  mem.encerradas.delete(sessionId);
}

/**
 * FUNÇÃO PURA: as notas desta sessão encerrada podem vir da memória neste ciclo?
 * Sim só se: a rebusca espaçada está ligada, há uma busca bem-sucedida guardada,
 * ela tem menos de (intervalo − folga), e ainda não são 23h BRT (a partir daí,
 * todo ciclo rebusca, para o fechamento do dia sair fresco).
 */
function servirDaMemoria(r, rebuscaMs, agora = relogio.agora()) {
  if (!(rebuscaMs > 0) || !r || !r.notas) return false;
  if (hourBRT(agora) >= HORA_REBUSCA_OBRIGATORIA) return false;
  return agora - r.notas.buscadoEm < Math.max(0, rebuscaMs - FOLGA_MS);
}

/** Guarda o resultado de uma busca — só quando as DUAS buscas responderam. */
function guardarNotas(r, rejRaw, execRaw, agora = relogio.agora()) {
  if (!Array.isArray(rejRaw) || !Array.isArray(execRaw)) return;
  r.notas = { rej: structuredClone(rejRaw), exec: structuredClone(execRaw), buscadoEm: agora };
}

function lerNotas(r) {
  return { rej: structuredClone(r.notas.rej), exec: structuredClone(r.notas.exec) };
}

// ── (5) modo sombra do V2 ───────────────────────────────────────────────────

/** O que no V2 mudaria se a equipe trabalhou numa nota. */
function assinaturaV2(v2) {
  if (!v2) return null;
  const ids = (arr) => (arr || []).map(n => `${n.Id || n.Number || ''}:${n.ExecutionStatus ?? ''}`).sort().join(',');
  return [v2.LastStatusUpdate || '', v2.LastUpdate || '', v2.Status || '',
          ids(v2.Concluded), ids(v2.Downloaded)].join('|');
}

/** O que as buscas por sessão trouxeram. */
function assinaturaNotas(rejRaw, execRaw) {
  const ids = (arr) => (arr || []).map(n => `${n.Id || n.Number || ''}:${n.ExecutionStatus ?? ''}`).sort().join(',');
  return `${ids(rejRaw)}#${ids(execRaw)}`;
}

/**
 * Registra uma comparação em sombra. Devolve 'nova' | 'v2-mudou' | 'pularia' |
 * 'divergiu'. 'divergiu' = o V2 estava igual ao ciclo anterior, mas as notas
 * NÃO — pular teria perdido dado.
 */
function registrarSombra(mem, sessionId, v2Sig, notasSig, meta = {}, agora = relogio.agora()) {
  mem.garantirDia(agora);
  const anterior = mem.sombra.get(sessionId);
  mem.sombra.set(sessionId, { v2Sig, notasSig });
  if (!anterior || v2Sig === null) return 'nova';
  if (anterior.v2Sig !== v2Sig) return 'v2-mudou';
  mem.contSombra.comparadas++;
  if (anterior.notasSig === notasSig) { mem.contSombra.pularia++; return 'pularia'; }
  mem.contSombra.divergiu++;
  if (mem.contSombra.exemplos.length < 20) {
    mem.contSombra.exemplos.push({ ...meta, sessionId, em: new Date(agora).toISOString() });
  }
  return 'divergiu';
}

function estado(mem) {
  return {
    dia: mem.dia,
    encerradasNaMemoria: mem.encerradas.size,
    rebuscaMin: rebuscaMsDoEnv() / 60_000,
    horaRebuscaObrigatoria: HORA_REBUSCA_OBRIGATORIA,
    sombraV2: { ...mem.contSombra, exemplos: [...mem.contSombra.exemplos] },
  };
}

const _memoria = criarMemoria();

module.exports = {
  rebuscaMsDoEnv, HORA_REBUSCA_OBRIGATORIA, relogio,
  criarMemoria,
  registroEncerrada, esquecerEncerrada,
  servirDaMemoria, guardarNotas, lerNotas,
  assinaturaV2, assinaturaNotas, registrarSombra,
  estado: () => estado(_memoria),
  memoria: _memoria,
};
