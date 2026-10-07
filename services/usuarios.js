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
 * TRAVA 5 na exclusão. Excluir = OCULTAR (decisão do José em 29/09/2026): a
 * linha fica no banco, some da lista, e o username nunca volta a ser usável.
 *
 * Só quem JÁ ESTÁ desativado pode ser excluído. São dois passos de propósito:
 * a desativação é o que corta o acesso (e passa pelas travas 1 e 2), e é
 * reversível pela tela; a exclusão só tira da lista, e não é. Assim nenhum
 * clique único faz o que não se desfaz pela tela.
 *
 * Como o alvo tem de estar inativo, as travas 1 e 2 valem por tabela: você não
 * está inativo (está logado), e um gestor inativo já não conta como gestor.
 *
 * @param todos  a lista de `listarDoBanco` — que já não traz os excluídos, então
 *               excluir de novo cai em "não existe"
 * @returns {{ok: boolean, motivo?: string}}
 */
function podeExcluir(alvoUsername, ator, todos) {
  const alvo = (todos || []).find(u => u.username === alvoUsername);
  if (!alvo) return { ok: false, motivo: `usuário "${alvoUsername}" não existe` };

  if (ator && alvo.username === ator.username) {
    return { ok: false, motivo: 'você não pode excluir a si mesmo' };
  }
  if (alvo.ativo) {
    return { ok: false, motivo: 'desative o usuário antes de excluir' };
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
  const excluido = !!row.excluido_em;
  return {
    username:       row.username,
    senha_hash:     row.senha_hash,
    role:           row.role,
    regionals:      _regs(row.regionals),
    // Excluído é SEMPRE inativo, mesmo que a linha diga o contrário (alguém
    // mexendo direto no banco). Defesa em profundidade: o acesso depende só de
    // `ativo`, então é aqui que a exclusão não pode ter brecha.
    ativo:          excluido ? false : row.ativo,
    excluido,
    pode_gerenciar: row.pode_gerenciar,
    // Incremento 2: com isto true, o authMiddleware tranca tudo menos a troca.
    senha_provisoria: row.senha_provisoria === true,
    criado_em:      row.criado_em,
    criado_por:     row.criado_por,
  };
}

const _COLS_BASE = ['username', 'senha_hash', 'role', 'regionals', 'ativo',
  'pode_gerenciar', 'criado_em', 'criado_por'];

/**
 * Colunas que vieram DEPOIS da tabela, cada uma com a migration que a cria.
 *
 * INCIDENTE 07/10/2026, 16:22–17:03: o pull do INTERR trouxe junto o código da
 * exclusão (f13f572), que lia `excluido_em`, sem o add_usuario_excluido.sql
 * aplicado. A leitura de usuários falhou inteira e, por ~40 min, SÓ a conta de
 * emergência entrava — e ela não listava usuários. Reporte do José: "as contas
 * além de admin não conseguem acessar, e a conta admin não está com acesso para
 * listar a lista de usuários". O aviso de "aplicar ANTES do pull" estava no
 * commit, no RUNBOOK e no backlog. Aviso em documento não segura um git pull.
 *
 * Por que tolerar a falta destas é SEGURO, e não fail-open: as duas só são
 * gravadas por código que exige a própria coluna. Se ela não existe, ninguém
 * PODE ter sido marcado — o default (não excluído, senha não provisória) é a
 * verdade, não um palpite. Coluna da tabela original (ativo, pode_gerenciar…)
 * NÃO entra aqui: a falta dela continua negando.
 */
const _COLS_OPCIONAIS = {
  senha_provisoria: 'migrations/add_senha_provisoria.sql',
  excluido_em:      'migrations/add_usuario_excluido.sql',
};

/** A coluna que o Postgres disse não existir (42703 = undefined_column), ou null. */
function _colunaFaltando(error) {
  if (!error) return null;
  const m = /column "?(?:\w+\.)?(\w+)"? does not exist/i.exec(error.message || '');
  if (error.code !== '42703' && !m) return null;
  return m ? m[1] : null;
}

/**
 * Descreve uma falha de leitura SEM mentir sobre a causa. Até 07/10/2026 todo
 * erro saía como "banco indisponível" — e no incidente o banco estava no ar,
 * faltava uma coluna. Quem lesse o log sem contexto ia investigar o Postgres.
 */
function descreverFalha(error) {
  const col = _colunaFaltando(error);
  if (col) {
    const mig = _COLS_OPCIONAIS[col];
    return `coluna "${col}" não existe no banco — migration pendente` +
      (mig ? `: aplique ${mig}` : '') + ` (o banco está NO AR; ${error.message})`;
  }
  return `banco indisponível: ${error && error.message}`;
}

/** Avisa UMA vez por coluna por processo — no incidente foram centenas de linhas iguais. */
const _jaAvisou = new Set();

/**
 * SELECT em `usuarios` que sobrevive a migration pendente.
 *
 * Tenta com todas as colunas; se o Postgres disser que falta uma OPCIONAL, tira
 * ela e tenta de novo, com um console.error alto e uma vez só. Falta de coluna
 * que não é opcional sobe como erro, como antes.
 *
 * @param montar  (sb, cols) => query — recebe as colunas como string
 */
async function _selecionar(montar) {
  const sb = require('./dbClient').getClient();
  const cols = [..._COLS_BASE, ...Object.keys(_COLS_OPCIONAIS)];
  for (let tentativa = 0; tentativa <= Object.keys(_COLS_OPCIONAIS).length; tentativa++) {
    const { data, error } = await montar(sb, cols.join(', '));
    if (!error) return data || [];

    const col = _colunaFaltando(error);
    if (!col || !_COLS_OPCIONAIS[col] || !cols.includes(col)) throw error;

    if (!_jaAvisou.has(col)) {
      _jaAvisou.add(col);
      console.error(`[usuarios] ⚠️ MIGRATION PENDENTE: ${descreverFalha(error)}. ` +
        'O login segue funcionando sem ela, mas a funcionalidade da coluna fica desligada.');
    }
    cols.splice(cols.indexOf(col), 1);
  }
  throw new Error('[usuarios] colunas opcionais esgotadas sem leitura válida');
}

/**
 * Todos os usuários do banco, MENOS os excluídos. Lança se o banco estiver fora.
 *
 * O filtro é aqui, e não em cada rota, de propósito: para a tela e para todas as
 * travas, excluído é "não existe" (404 em editar, resetar, reativar). Uma rota
 * nova herda isso sem precisar lembrar — que é como as travas foram parar num
 * lugar só (ver o cabeçalho).
 */
async function listarDoBanco() {
  const data = await _selecionar((sb, cols) =>
    sb.from('usuarios').select(cols).order('username'));
  return data.map(_daLinha).filter(u => !u.excluido);
}

/**
 * O username já existiu e foi excluído? Só para a mensagem do 409 ao criar:
 * "já existe" confundiria quem não vê o nome na lista.
 */
async function foiExcluido(username) {
  const sb = require('./dbClient').getClient();
  const { data, error } = await sb.from('usuarios').select('excluido_em').eq('username', username);
  if (error) return false;
  return !!((data || [])[0] || {}).excluido_em;
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
    const data = await _selecionar((sb, cols) =>
      sb.from('usuarios').select(cols).eq('username', username));
    const achado = _daLinha(data[0]);
    if (achado) _cache.por(username, achado);
    return achado;
  } catch (err) {
    console.warn(`[usuarios] falha ao ler "${username}" (${descreverFalha(err)}); usando último conhecido`);
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
  validarNovoUsuario, podeDesativar, podeAlterar, podeExcluir, gerarSenha,
  validarTrocaSenha, SENHA_MIN,
  listarDoBanco, foiExcluido, buscar, registrarLog, descreverFalha,
  _cache, CACHE_TTL_MS,
  RE_USERNAME, ROLES,
};
