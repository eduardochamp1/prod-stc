/**
 * services/usuarios.js
 *
 * Gestão de usuários do painel: as TRAVAS (puras) e o acesso ao banco.
 *
 * ⚠️ Isto é autenticação. Cinco itens do backlog já foram furos de controle de
 * acesso neste código (P0-4, P1-12, P1-18, P1-38, P1-42). As travas ficam aqui,
 * num lugar só — não espalhadas pelas rotas, onde uma seria esquecida.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md
 */

'use strict';

const crypto = require('crypto');
const { isValidRegional } = require('./regionals');

const RE_USERNAME = /^[a-z0-9_]{3,32}$/;
const ROLES = ['admin', 'user'];

/**
 * Alfabeto da senha gerada, SEM caracteres ambíguos (O/0, l/1/I).
 * A senha é transcrita à mão de uma pessoa pra outra; um zero lido como "ó"
 * vira "não consigo entrar" e um reset desnecessário.
 */
const MAIUSCULAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MINUSCULAS = 'abcdefghijkmnopqrstuvwxyz';
const DIGITOS    = '23456789';
const SIMBOLOS   = '!@#$%&*';
const ALFABETO   = MAIUSCULAS + MINUSCULAS + DIGITOS + SIMBOLOS;
const SENHA_LEN  = 20;

/** Índice uniforme em [0, n), sem viés de módulo. */
function _sorteia(n) {
  const limite = Math.floor(256 / n) * n;
  for (;;) {
    const b = crypto.randomBytes(1)[0];
    if (b < limite) return b % n;
  }
}

/**
 * Senha forte, aleatória por crypto. Mostrada UMA vez e nunca guardada.
 *
 * GARANTE ao menos uma maiúscula, uma minúscula e um dígito, em vez de deixar
 * por conta da sorte. Descoberto em 21/09/2026 pelo teste de alfabeto: com
 * sorteio uniforme sobre o alfabeto inteiro, uma senha de 20 caracteres pode
 * sair sem nenhum dígito — e senha gerada pelo sistema não deveria ser mais
 * fraca que a que a pessoa escolheria.
 */
function gerarSenha() {
  const chars = [
    MAIUSCULAS[_sorteia(MAIUSCULAS.length)],
    MINUSCULAS[_sorteia(MINUSCULAS.length)],
    DIGITOS[_sorteia(DIGITOS.length)],
  ];
  while (chars.length < SENHA_LEN) chars.push(ALFABETO[_sorteia(ALFABETO.length)]);

  // Embaralha (Fisher-Yates), senão os três garantidos ficam sempre no início.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = _sorteia(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Normaliza a lista de regionais vinda do payload. */
function _regs(v) {
  if (Array.isArray(v)) return v.map(s => String(s || '').trim().toUpperCase()).filter(Boolean);
  return String(v === null || v === undefined ? '' : v)
    .split('|').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Valida o payload de criação.
 *
 * @param payload     { username, role, regionals }
 * @param ator        quem está criando — { username, regionals, pode_gerenciar }
 * @param reservados  Set de usernames do AUTH_USERS (conta de emergência)
 * @returns string[]  vazio = válido
 */
function validarNovoUsuario(payload, ator, reservados) {
  const erros = [];
  const p = payload || {};
  const username = String(p.username || '').trim().toLowerCase();

  if (!RE_USERNAME.test(username)) {
    erros.push('username inválido (3 a 32 caracteres: minúsculas, números ou _)');
  }
  if ((reservados || new Set()).has(username)) {
    erros.push(`username "${username}" é reservado pela conta de emergência do .env`);
  }
  if (!ROLES.includes(p.role)) erros.push("role deve ser 'admin' ou 'user'");

  const regs = _regs(p.regionals);
  if (regs.length === 0) {
    erros.push('informe ao menos uma regional');
  } else {
    const invalidas = regs.filter(r => !isValidRegional(r));
    if (invalidas.length) erros.push(`regionais inválidas: ${invalidas.join(', ')}`);

    // TRAVA 4: um gestor só concede o que ele próprio tem.
    const doAtor = new Set(_regs(ator && ator.regionals));
    const fora = regs.filter(r => !doAtor.has(r));
    if (fora.length) {
      erros.push(`você não pode conceder regionais que não tem: ${fora.join(', ')}`);
    }
  }
  return erros;
}

/**
 * Comprimento mínimo da senha que a PESSOA escolhe.
 *
 * 8, sem exigência de maiúscula, número ou símbolo — decisão explícita do José
 * em 22/09/2026. Fica registrado que a recomendação foi 12 sem composição: a
 * orientação atual é que comprimento supera composição, e regras de composição
 * produzem "Senha@2026" repetida em todo lugar.
 *
 * O painel fica em rede interna e tem rate limit por IP e por usuário (P1-42),
 * o que atenua — não elimina.
 */
const SENHA_MIN = 8;

/**
 * Valida a troca da PRÓPRIA senha.
 *
 * As duas checagens além do comprimento NÃO são política de força; são o que
 * faz o fluxo significar alguma coisa:
 *
 *  - exigir a senha ATUAL: sem isso, quem pegar uma sessão aberta troca a
 *    senha sem saber a antiga;
 *  - recusar nova IGUAL à atual: sem isso, a pessoa "troca" para a mesma
 *    sequência provisória, a marca de provisória some, e nada mudou.
 *
 * @returns string[]  vazio = válido
 */
function validarTrocaSenha(payload) {
  const erros = [];
  const p = payload || {};
  const atual = String(p.atual === null || p.atual === undefined ? '' : p.atual);
  const nova  = String(p.nova  === null || p.nova  === undefined ? '' : p.nova);

  if (!atual.trim()) erros.push('informe a senha atual');
  if (!nova.trim()) {
    erros.push('informe a senha nova');
  } else if (nova.length < SENHA_MIN) {
    erros.push(`a senha nova precisa ter ao menos ${SENHA_MIN} caracteres`);
  } else if (nova === atual) {
    erros.push('a senha nova precisa ser diferente da atual');
  }
  return erros;
}

/** Quantos gestores ATIVOS sobrariam se `mudanca` fosse aplicada. */
function _gestoresAtivos(todos, excluir, tirarGerenciaDe) {
  return (todos || []).filter(u =>
    u.ativo &&
    u.pode_gerenciar &&
    u.username !== excluir &&
    u.username !== tirarGerenciaDe).length;
}

/**
 * TRAVAS 1 e 2 na desativação.
 * @returns {{ok: boolean, motivo?: string}}
 */
function podeDesativar(alvoUsername, ator, todos) {
  const alvo = (todos || []).find(u => u.username === alvoUsername);
  if (!alvo) return { ok: false, motivo: `usuário "${alvoUsername}" não existe` };

  if (ator && alvo.username === ator.username) {
    return { ok: false, motivo: 'você não pode desativar a si mesmo' };
  }
  if (alvo.pode_gerenciar && _gestoresAtivos(todos, alvoUsername, null) === 0) {
    return { ok: false, motivo: 'precisa sobrar ao menos um gestor ativo' };
  }
  return { ok: true };
}

/**
 * TRAVAS 1b, 2b, 3 e 4b na alteração.
 * @returns {{ok: boolean, motivo?: string}}
 */
function podeAlterar(payload, alvo, ator, todos) {
  const p = payload || {};

  if (p.pode_gerenciar === false && ator && alvo.username === ator.username) {
    return { ok: false, motivo: 'você não pode tirar a própria permissão de gerenciar' };
  }
  if (p.pode_gerenciar === true && !(ator && ator.pode_gerenciar)) {
    return { ok: false, motivo: 'só quem pode gerenciar concede essa permissão' };
  }
  if (p.pode_gerenciar === false && alvo.pode_gerenciar
      && _gestoresAtivos(todos, null, alvo.username) === 0) {
    return { ok: false, motivo: 'precisa sobrar ao menos um gestor ativo' };
  }
  if (p.regionals !== undefined) {
    const regs = _regs(p.regionals);
    if (regs.length === 0) return { ok: false, motivo: 'informe ao menos uma regional' };
    const invalidas = regs.filter(r => !isValidRegional(r));
    if (invalidas.length) return { ok: false, motivo: `regionais inválidas: ${invalidas.join(', ')}` };
    const doAtor = new Set(_regs(ator && ator.regionals));
    const fora = regs.filter(r => !doAtor.has(r));
    if (fora.length) {
      return { ok: false, motivo: `você não pode conceder regionais que não tem: ${fora.join(', ')}` };
    }
  }
  if (p.role !== undefined && !ROLES.includes(p.role)) {
    return { ok: false, motivo: "role deve ser 'admin' ou 'user'" };
  }
  return { ok: true };
}

/**
 * Cache de usuário em memória.
 *
 * TTL de 30s: é o TETO de quanto tempo um acesso retirado pode sobreviver.
 * Meio minuto é curto o bastante pra "na hora" ser verdade, e longo o bastante
 * pra o painel não consultar o banco a cada clique.
 *
 * `ler` respeita o TTL. `ultimoConhecido` ignora o TTL de propósito: é o
 * fallback de quando o banco está fora (spec §3.5). Sem entrada nenhuma, os
 * dois devolvem null — e quem chama NEGA. Fail-open é proibido aqui; é o
 * defeito que o P1-32 consertou no breaker de login.
 */
const CACHE_TTL_MS = 30_000;

const _mapa = new Map();   // username → { dados, ts }

const _cache = {
  por(username, dados) { _mapa.set(username, { dados, ts: Date.now() }); },
  ler(username) {
    const e = _mapa.get(username);
    if (!e) return null;
    return (Date.now() - e.ts) > CACHE_TTL_MS ? null : e.dados;
  },
  ultimoConhecido(username) {
    const e = _mapa.get(username);
    return e ? e.dados : null;
  },
  /** Apaga de verdade — é o que faz a revogação valer ANTES dos 30s. */
  invalidar(username) { _mapa.delete(username); },
  limpar() { _mapa.clear(); },
  /** Só pra teste: empurra a entrada pro passado. */
  envelhecer(username, ms) {
    const e = _mapa.get(username);
    if (e) e.ts -= ms;
  },
};

/** Linha da tabela → objeto de usuário, com regionals já em array. */
function _daLinha(row) {
  if (!row) return null;
  return {
    username:       row.username,
    senha_hash:     row.senha_hash,
    role:           row.role,
    regionals:      _regs(row.regionals),
    ativo:          row.ativo,
    pode_gerenciar: row.pode_gerenciar,
    // Incremento 2: com isto true, o authMiddleware tranca tudo menos a troca.
    senha_provisoria: row.senha_provisoria === true,
    criado_em:      row.criado_em,
    criado_por:     row.criado_por,
  };
}

const _COLS = 'username, senha_hash, role, regionals, ativo, pode_gerenciar, senha_provisoria, criado_em, criado_por';

/** Todos os usuários do banco. Lança se o banco estiver fora. */
async function listarDoBanco() {
  const sb = require('./dbClient').getClient();
  const { data, error } = await sb.from('usuarios').select(_COLS).order('username');
  if (error) throw error;
  return (data || []).map(_daLinha);
}

/**
 * Um usuário, pelo cache quando possível.
 *
 * Com o banco fora, cai no último conhecido. Sem último conhecido, devolve
 * null — e quem chama NEGA.
 */
async function buscar(username) {
  const doCache = _cache.ler(username);
  if (doCache) return doCache;

  try {
    const sb = require('./dbClient').getClient();
    const { data, error } = await sb.from('usuarios').select(_COLS).eq('username', username);
    if (error) throw error;
    const achado = _daLinha((data || [])[0]);
    if (achado) _cache.por(username, achado);
    return achado;
  } catch (err) {
    console.warn('[usuarios] banco indisponível, usando último conhecido:', err.message);
    return _cache.ultimoConhecido(username);
  }
}

/** Registra na trilha. NUNCA recebe senha nem hash em `detalhe`. */
async function registrarLog(ator, acao, alvo, detalhe) {
  try {
    const sb = require('./dbClient').getClient();
    const { error } = await sb.from('usuarios_log')
      .insert({ ator, acao, alvo, detalhe: detalhe || null });
    if (error) throw error;
  } catch (err) {
    // A trilha não pode derrubar a operação, mas o silêncio também não serve.
    console.error('[usuarios] FALHA ao gravar auditoria:', { ator, acao, alvo }, err.message);
  }
}

module.exports = {
  validarNovoUsuario, podeDesativar, podeAlterar, gerarSenha,
  validarTrocaSenha, SENHA_MIN,
  listarDoBanco, buscar, registrarLog,
  _cache, CACHE_TTL_MS,
  RE_USERNAME, ROLES,
};
