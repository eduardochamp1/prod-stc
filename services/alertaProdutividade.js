/**
 * services/alertaProdutividade.js
 *
 * Alerta de BAIXA PRODUTIVIDADE (14/10/2026, pedido do José).
 * Ver docs/handoff/SPEC-alerta-produtividade-2026-10-14.md e o PLAN.
 *
 * Avisa quando uma equipe chega à metade do turno com MENOS de `limite` notas
 * executadas (não rejeitadas). Só avisa: nenhuma ação do supervisor.
 *
 * Este arquivo tem duas camadas:
 *   1. regras PURAS (aqui, no topo): meioDoTurno, emRefeicao, validarConfig,
 *      avaliarEquipe. Sem banco, sem WPA, sem relógio — tudo entra por parâmetro.
 *   2. `avaliarCiclo(deps)` (mais abaixo): orquestra e GRAVA, com as dependências
 *      INJETADAS. O backlog P2-39 documenta que funções de cron são invisíveis à
 *      suíte (saem cedo sem banco; erro de escopo só estoura em produção, na hora
 *      agendada). Por isso NENHUM `require` de banco/WPA no topo deste arquivo.
 *
 * Nada aqui mexe em número reportado à EDP: o alerta só LÊ a produção.
 */

'use strict';

const { CATEGORIAS, OPERACIONAL } = require('./categoriasEquipe');

// ── Configuração ─────────────────────────────────────────────────────────────

/** Nasce DESLIGADO. Ausente/ilegível/inválido nunca liga (spec §4). */
const DEFAULT_CONFIG = Object.freeze({
  ativo: false,
  limite: 4,
  categorias: Object.freeze(['COMERCIAL', 'PLANTAO', 'MOTO', 'BT_ZERO']),
  tolerancia_refeicao_min: 60,
});

const _CATEGORIAS_VALIDAS = new Set([...CATEGORIAS.map(c => c.chave), OPERACIONAL.chave]);

function _configPadrao() {
  return {
    ativo: DEFAULT_CONFIG.ativo,
    limite: DEFAULT_CONFIG.limite,
    categorias: [...DEFAULT_CONFIG.categorias],
    tolerancia_refeicao_min: DEFAULT_CONFIG.tolerancia_refeicao_min,
  };
}

/**
 * FUNÇÃO PURA. Valida e normaliza a configuração.
 *
 * @param {*} raw  o que veio de app_settings / do PUT
 * @returns {{ ok: boolean, erros: string[], config: object }}
 *   `config` é SEMPRE utilizável: em qualquer erro volta o padrão DESLIGADO —
 *   configuração quebrada nunca liga o alerta.
 */
function validarConfig(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, erros: ['configuração ausente ou ilegível'], config: _configPadrao() };
  }
  const erros = [];
  const cfg = _configPadrao();

  if (raw.ativo !== undefined) {
    if (typeof raw.ativo !== 'boolean') erros.push('ativo deve ser true ou false');
    else cfg.ativo = raw.ativo;
  }
  if (raw.limite !== undefined) {
    if (!Number.isInteger(raw.limite) || raw.limite < 1) erros.push('limite deve ser inteiro >= 1');
    else cfg.limite = raw.limite;
  }
  if (raw.tolerancia_refeicao_min !== undefined) {
    if (!Number.isInteger(raw.tolerancia_refeicao_min) || raw.tolerancia_refeicao_min < 0) {
      erros.push('tolerancia_refeicao_min deve ser inteiro >= 0');
    } else cfg.tolerancia_refeicao_min = raw.tolerancia_refeicao_min;
  }
  if (raw.categorias !== undefined) {
    if (!Array.isArray(raw.categorias)) erros.push('categorias deve ser uma lista');
    else {
      const ruins = raw.categorias.filter(c => !_CATEGORIAS_VALIDAS.has(c));
      if (ruins.length) erros.push(`categoria inexistente: ${ruins.join(', ')}`);
      else cfg.categorias = [...raw.categorias];
    }
  }
  if (erros.length === 0 && cfg.ativo && cfg.categorias.length === 0) {
    erros.push('com o alerta ativo, categorias não pode ser vazia');
  }

  if (erros.length) return { ok: false, erros, config: _configPadrao() };
  return { ok: true, erros: [], config: cfg };
}

// ── Tempo ────────────────────────────────────────────────────────────────────

/** 'HH:MM' ou 'HH:MM:SS' (formato do TIME do Postgres) → minutos desde 00:00, ou null. */
function minutosDeHM(hm) {
  if (typeof hm !== 'string') return null;
  const m = hm.trim().match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * FUNÇÃO PURA. Minuto (desde 00:00 BRT) do MEIO do turno, ou null.
 * Null quando falta dado, o formato é inválido, ou o turno atravessa a
 * meia-noite (`fim <= inicio`) — turno vira-noite está fora da v1 (spec A2): ao
 * vivo o "dia" dele é ambíguo, porque o `_effDate` só existe na consolidação.
 */
function meioDoTurno(inicio, fim) {
  const i = minutosDeHM(inicio);
  const f = minutosDeHM(fim);
  if (i === null || f === null || f <= i) return null;
  return Math.floor((i + f) / 2);
}

// ── Refeição ─────────────────────────────────────────────────────────────────

/**
 * FUNÇÃO PURA. A equipe está em refeição AGORA?
 *
 * Verdadeiro só com intervalo EM ABERTO (`emAberto`, EndTime nulo) cujo motivo
 * casa /refei/i (vem como "15 - Horário de Refeição"). Isso dispensa comparar
 * horários — e portanto NÃO depende do defeito de fuso do P1-48, que afeta o
 * `inicio/fim` dos intervalos mas não o estado "aberto".
 *
 * @param {Array<{motivo:string|null, emAberto:boolean}>} breaks  de getSessionBreaks
 */
function emRefeicao(breaks) {
  if (!Array.isArray(breaks)) return false;
  return breaks.some(b => b && b.emAberto === true && /refei/i.test(String(b.motivo || '')));
}

// ── A regra ──────────────────────────────────────────────────────────────────

/**
 * FUNÇÃO PURA. Decide o que fazer com UMA equipe neste ciclo.
 *
 * @param {object} e
 * @param {number}  e.agoraMin      minutos desde 00:00 BRT (timeUtil.minutosBRT)
 * @param {object}  e.config        saída de validarConfig().config
 * @param {{inicio:string|null, fim:string|null}|null} e.escala  escala_inicio/fim
 * @param {number}  e.executadas    concluídas NÃO rejeitadas do dia (team_daily_totals)
 * @param {number}  e.rejeitadas    só contexto — NUNCA entra na conta
 * @param {boolean} e.sessaoAberta  sessão de hoje, sem sessionEnd
 * @param {boolean} e.ehReal        equipe REAL (não a fantasma do _acc)
 * @param {string}  e.categoria     chave de categoriaDaSigla()
 * @param {boolean} e.aberto        já existe alerta de hoje, não resolvido
 * @param {boolean} e.resolvido     já existe alerta de hoje, resolvido
 * @param {boolean|null} e.emRefeicao  true/false; null = consulta falhou ou não feita
 * @returns {{ estado: 'nenhum'|'ignorar'|'abrir'|'manter'|'resolver'|'adiar', motivo: string }}
 *
 * Um alerta por equipe por dia: `resolvido` nunca reabre.
 */
function avaliarEquipe(e) {
  const cfg = e.config || DEFAULT_CONFIG;
  if (!cfg.ativo) return { estado: 'nenhum', motivo: 'desligado' };
  if (!e.ehReal || !e.sessaoAberta) return { estado: 'nenhum', motivo: 'sem_sessao_aberta' };
  if (!(cfg.categorias || []).includes(e.categoria)) return { estado: 'nenhum', motivo: 'categoria_fora' };

  if (e.resolvido) return { estado: 'nenhum', motivo: 'ja_resolvido' };
  if (e.aberto) {
    // Aberto resolve ao atingir o limite, a qualquer hora (inclusive após o fim do
    // turno). Se as executadas caírem depois (nota que virou rejeitada), continua
    // aberto. NÃO consulta refeição: refeição só serve pra decidir ABRIR.
    return e.executadas >= cfg.limite
      ? { estado: 'resolver', motivo: 'atingiu_limite' }
      : { estado: 'manter', motivo: 'abaixo_do_limite' };
  }

  const ini = minutosDeHM(e.escala && e.escala.inicio);
  const fim = minutosDeHM(e.escala && e.escala.fim);
  if (ini === null || fim === null) return { estado: 'ignorar', motivo: 'sem_escala' };
  if (fim <= ini) return { estado: 'ignorar', motivo: 'vira_noite' };

  const meio = Math.floor((ini + fim) / 2);
  if (e.agoraMin < meio) return { estado: 'nenhum', motivo: 'antes_do_meio' };
  if (e.agoraMin >= fim) return { estado: 'nenhum', motivo: 'apos_fim' };

  if (e.executadas >= cfg.limite) return { estado: 'nenhum', motivo: 'acima_do_limite' };

  // Chegou aqui: passou do meio, abaixo do limite → candidata. Falta a refeição.
  // Sem a informação (null) NUNCA alerta: alertar por falta de dado sobre o almoço
  // é exatamente o falso alarme que a regra quer evitar.
  if (e.emRefeicao === null || e.emRefeicao === undefined) {
    return { estado: 'adiar', motivo: 'refeicao_indisponivel' };
  }
  // Em refeição, adia até `meio + tolerância` (sem estado: não precisa lembrar
  // "desde quando adiou"). Depois disso avalia mesmo assim — almoço de mais de 1h
  // também é informação pro supervisor.
  if (e.emRefeicao === true && e.agoraMin < meio + cfg.tolerancia_refeicao_min) {
    return { estado: 'adiar', motivo: 'refeicao' };
  }
  return { estado: 'abrir', motivo: 'abaixo_do_limite_no_meio_do_turno' };
}

module.exports = {
  DEFAULT_CONFIG,
  validarConfig,
  minutosDeHM,
  meioDoTurno,
  emRefeicao,
  avaliarEquipe,
};
