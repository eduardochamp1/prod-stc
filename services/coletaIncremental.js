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
 *  (3b) NOTAS de sessão encerrada — continuam sendo buscadas durante uma JANELA
 *       depois que a vimos encerrada (o app transmite com atraso); a primeira
 *       busca feita DEPOIS da janela é a última, e o resultado fica congelado.
 *       DESLIGADO por padrão: `WPA_ENCERRADA_CONGELA_MIN` vazio/0 = busca a cada
 *       ciclo, como antes. A janela sai do histórico, não de palpite:
 *       `node scripts/diag-sessao-encerrada.js` mede, nos snapshots guardados,
 *       quanto tempo depois de encerrada uma sessão ainda muda de notas.
 *       ⚠️ A janela conta pelo NOSSO relógio (quando o coletor viu a sessão
 *       encerrada pela 1ª vez), NÃO pelo `EndTime` da EDP: o fuso desse campo é
 *       ambíguo (família do P1-48), e um erro de 3h ali congelaria cedo demais.
 *       Só congela com as DUAS buscas bem-sucedidas: falha de rede volta [] no
 *       _safeNotes, e congelar um [] de falha seria apagar produção.
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
 * ser buscada e a janela recomeça — mais requisições, nunca dado a menos. As
 * memórias são zeradas na virada do dia BRT.
 */

'use strict';

const { dateBRT } = require('./timeUtil');

function congelaMsDoEnv() {
  const n = Number(process.env.WPA_ENCERRADA_CONGELA_MIN);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : 0;
}

// ── memórias, zeradas na virada do dia ──────────────────────────────────────

function criarMemoria() {
  const m = { dia: null, encerradas: new Map(), sombra: new Map(),
              contSombra: { comparadas: 0, pularia: 0, divergiu: 0, exemplos: [] } };
  m.garantirDia = (agora = Date.now()) => {
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
function registroEncerrada(mem, sessionId, agora = Date.now()) {
  mem.garantirDia(agora);
  let r = mem.encerradas.get(sessionId);
  if (!r) {
    r = { vistaEncerradaEm: agora, colaboradores: null, notas: null };
    mem.encerradas.set(sessionId, r);
  }
  return r;
}

/**
 * Sessão vista ABERTA de novo (reabriu): esquece o registro de encerrada, e a
 * janela recomeça quando ela fechar outra vez. A memória da sombra (aberta)
 * fica — é ela que compara um ciclo com o anterior.
 */
function esquecerEncerrada(mem, sessionId) {
  mem.encerradas.delete(sessionId);
}

/**
 * FUNÇÃO PURA: as notas desta sessão encerrada podem ser servidas da memória?
 * Só se a janela está ligada e a última busca bem-sucedida foi feita DEPOIS de
 * `vistaEncerradaEm + janela`.
 */
function notasCongeladas(r, congelaMs) {
  if (!(congelaMs > 0) || !r || !r.notas) return false;
  return r.notas.buscadoEm >= r.vistaEncerradaEm + congelaMs;
}

/** Guarda o resultado de uma busca — só quando as DUAS buscas responderam. */
function guardarNotas(r, rejRaw, execRaw, agora = Date.now()) {
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
function registrarSombra(mem, sessionId, v2Sig, notasSig, meta = {}, agora = Date.now()) {
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
    congelaMin: congelaMsDoEnv() / 60_000 || 0,
    sombraV2: { ...mem.contSombra, exemplos: [...mem.contSombra.exemplos] },
  };
}

const _memoria = criarMemoria();

module.exports = {
  congelaMsDoEnv,
  criarMemoria,
  registroEncerrada, esquecerEncerrada,
  notasCongeladas, guardarNotas, lerNotas,
  assinaturaV2, assinaturaNotas, registrarSombra,
  estado: () => estado(_memoria),
  memoria: _memoria,
};
