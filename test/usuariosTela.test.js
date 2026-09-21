/**
 * test/usuariosTela.test.js
 *
 * A tela de Usuários do Painel. As duas funções de renderização são PURAS,
 * então aqui elas são extraídas do index.html e EXECUTADAS.
 *
 * Limite explícito: isto NÃO prova que a tela renderiza no browser.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md §6.5
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Extrai uma função do index.html, pulando a lista de parâmetros. */
function extrairFuncao(nome) {
  const marca = `function ${nome}(`;
  const ini   = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei ${marca} no index.html`);

  let paren = 0, fimParams = -1;
  for (let i = ini + marca.length - 1; i < SRC.length; i++) {
    if (SRC[i] === '(') paren++;
    else if (SRC[i] === ')') { paren--; if (paren === 0) { fimParams = i; break; } }
  }
  assert.ok(fimParams > -1, `parênteses não fecharam em ${nome}`);

  const abre = SRC.indexOf('{', fimParams);
  let nivel = 0;
  for (let i = abre; i < SRC.length; i++) {
    if (SRC[i] === '{') nivel++;
    else if (SRC[i] === '}') { nivel--; if (nivel === 0) return SRC.slice(ini, i + 1); }
  }
  throw new Error(`chaves não fecharam em ${nome}`);
}

function carregar(nome) {
  return new Function(`
    ${extrairFuncao('escapeHtml')}
    ${extrairFuncao(nome)}
    return ${nome};
  `)();
}

function usr(over = {}) {
  return {
    username: 'fulano', role: 'user', regionals: ['GUA'],
    ativo: true, pode_gerenciar: false, ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A lista
// ─────────────────────────────────────────────────────────────────────────────

test('a lista mostra usuário, papel, regionais, gestão e situação', () => {
  const render = carregar('_renderUsuarios');
  const html = render([usr({ username: 'jose', role: 'admin',
    regionals: ['GUA','CAC'], pode_gerenciar: true })]);

  assert.ok(html.includes('jose'));
  assert.ok(html.includes('admin'));
  assert.ok(html.includes('GUA, CAC'));
  assert.ok(html.includes('gestor'));
  assert.ok(html.includes('Ativo'));
});

test('usuário inativo aparece esmaecido e com o botão de Ativar', () => {
  // Desativado não some da lista: some do acesso, não do relatório.
  const render = carregar('_renderUsuarios');
  const html = render([usr({ ativo: false })]);

  assert.ok(html.includes('Inativo'));
  assert.ok(html.includes('Ativar'));
  assert.ok(html.includes('opacity:.45'));
});

test('lista vazia não quebra', () => {
  const render = carregar('_renderUsuarios');
  assert.ok(render([]).includes('Nenhum usuário'));
  assert.ok(render(null).includes('Nenhum usuário'));
});

test('a lista NUNCA mostra senha nem hash', () => {
  // Defesa em profundidade: a rota já filtra (teste em usuariosHttp), e a tela
  // não exibiria mesmo que passasse.
  const render = carregar('_renderUsuarios');
  const html = render([{ ...usr(), senha_hash: 'scrypt$aa$bb' }]);

  assert.ok(!html.includes('scrypt$'), 'hash vazou pra tela');
  assert.ok(!html.includes('senha_hash'));
});

test('username vindo do banco é escapado', () => {
  const render = carregar('_renderUsuarios');
  const html = render([usr({ username: '<img src=x onerror=alert(1)>' })]);
  assert.ok(!html.includes('<img src=x'), 'HTML cru vazou pra tela');
  assert.ok(html.includes('&lt;img'));
});

// ─────────────────────────────────────────────────────────────────────────────
// A trilha
// ─────────────────────────────────────────────────────────────────────────────

test('a trilha mostra quem, o quê, em quem e quando', () => {
  const render = carregar('_renderUsuariosLog');
  const html = render([{
    id: 1, ts: '2026-09-21T12:00:00.000Z', ator: 'jose',
    acao: 'desativar', alvo: 'fulano', detalhe: null,
  }]);

  assert.ok(html.includes('jose'));
  assert.ok(html.includes('desativar'));
  assert.ok(html.includes('fulano'));
});

test('a trilha vazia diz que está vazia, em vez de sumir', () => {
  const render = carregar('_renderUsuariosLog');
  assert.ok(render([]).includes('Nenhum registro'));
});

test('o detalhe da trilha é escapado', () => {
  const render = carregar('_renderUsuariosLog');
  const html = render([{
    id: 1, ts: '2026-09-21T12:00:00.000Z', ator: 'jose',
    acao: 'alterar', alvo: 'fulano',
    detalhe: { nota: '<script>alert(1)</script>' },
  }]);
  assert.ok(!html.includes('<script>alert'), 'detalhe cru vazou pra tela');
});

// ─────────────────────────────────────────────────────────────────────────────
// O aviso da senha
// ─────────────────────────────────────────────────────────────────────────────

test('a tela avisa que desativar leva ATÉ 30 SEGUNDOS, não "imediato"', () => {
  // Prometer "imediato" seria mentira por meio minuto — é o TTL do cache.
  const i = SRC.indexOf('Usuários do Painel');
  assert.ok(i > -1, 'não achei a seção de usuários');
  const bloco = SRC.slice(i, i + 700);
  assert.ok(/30 segundos/.test(bloco),
    'o texto tem de dizer o prazo real, que é o TTL do cache');
});

test('o aviso da senha diz que ela não será mostrada de novo', () => {
  const fonte = extrairFuncao('_mostrarSenhaGerada');
  assert.ok(/n[ãa]o ser[áa] mostrada de novo/i.test(fonte),
    'sem esse aviso, a pessoa fecha a tela e perde a senha sem saber');
});
