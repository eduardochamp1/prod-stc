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

module.exports = {
  validarNovoUsuario, podeDesativar, podeAlterar, gerarSenha,
  RE_USERNAME, ROLES,
};
