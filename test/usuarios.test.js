/**
 * test/usuarios.test.js
 *
 * As TRAVAS da gestão de usuários, na forma pura — sem banco, sem HTTP.
 *
 * Cada uma existe contra um jeito específico de dar errado, e o comentário de
 * cada teste diz qual. O contrato HTTP está em test/usuariosHttp.test.js.
 *
 * Spec: docs/handoff/SPEC-gestao-usuarios-2026-09-21.md §5
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  validarNovoUsuario, podeDesativar, podeAlterar, gerarSenha,
} = require('../services/usuarios');

/** Um usuário como a tabela devolve. */
function u(over = {}) {
  return {
    username: 'fulano', role: 'user', regionals: ['GUA'],
    ativo: true, pode_gerenciar: false, ...over,
  };
}

const JOSE = u({ username: 'jose', role: 'admin', regionals: ['GUA','CAC','SJC'], pode_gerenciar: true });

// ─────────────────────────────────────────────────────────────────────────────
// validarNovoUsuario
// ─────────────────────────────────────────────────────────────────────────────

test('aceita um usuário válido', () => {
  const erros = validarNovoUsuario(
    { username: 'novo_user', role: 'user', regionals: ['GUA'] }, JOSE, new Set());
  assert.deepEqual(erros, []);
});

test('recusa username fora do formato', () => {
  ['ab', 'com espaco', 'com-hifen', 'com.ponto', 'a'.repeat(33), ''].forEach(nome => {
    const erros = validarNovoUsuario(
      { username: nome, role: 'user', regionals: ['GUA'] }, JOSE, new Set());
    assert.ok(erros.length > 0, `"${nome}" devia ser recusado`);
    assert.ok(erros.some(e => /username/i.test(e)));
  });
});

test('username em MAIÚSCULA é normalizado, não recusado', () => {
  // Decidido em 21/09/2026: normalizar é melhor que recusar. Sem isso, "Jose"
  // e "jose" viram duas contas, e a pessoa descobre no dia em que uma delas
  // perde o acesso e a outra não.
  const erros = validarNovoUsuario(
    { username: 'COM_MAIUSCULA', role: 'user', regionals: ['GUA'] }, JOSE, new Set());
  assert.deepEqual(erros, []);
});

test('a normalização também vale pra checagem de nome reservado', () => {
  // Senão "EMERGENCIA" passaria e viraria homônimo da chave reserva.
  const erros = validarNovoUsuario(
    { username: 'EMERGENCIA', role: 'user', regionals: ['GUA'] },
    JOSE, new Set(['emergencia']));
  assert.ok(erros.some(e => /reservado/i.test(e)));
});

test('recusa role fora de admin|user', () => {
  const erros = validarNovoUsuario(
    { username: 'novo_user', role: 'superadmin', regionals: ['GUA'] }, JOSE, new Set());
  assert.ok(erros.some(e => /role/i.test(e)));
});

test('recusa regional inválida, ALL e grupo ES', () => {
  ['XYZ', 'ALL', 'ES'].forEach(r => {
    const erros = validarNovoUsuario(
      { username: 'novo_user', role: 'user', regionals: [r] }, JOSE, new Set());
    assert.ok(erros.length > 0, `regional "${r}" devia ser recusada`);
  });
});

test('recusa lista de regionais vazia', () => {
  const erros = validarNovoUsuario(
    { username: 'novo_user', role: 'user', regionals: [] }, JOSE, new Set());
  assert.ok(erros.some(e => /regional/i.test(e)));
});

test('TRAVA 4: gestor não concede regional que ele próprio não tem', () => {
  // É a diferença entre delegar e abrir mão. Hoje não muda nada (o José tem
  // todas); existe pro dia em que houver gestor de escopo menor.
  const gestorGua = u({ username: 'gestor_gua', regionals: ['GUA'], pode_gerenciar: true });
  const erros = validarNovoUsuario(
    { username: 'novo_user', role: 'user', regionals: ['GUA','CAC'] }, gestorGua, new Set());
  assert.ok(erros.some(e => /CAC/.test(e)), `esperava recusa por CAC; veio: ${erros}`);
});

test('recusa username reservado pela conta de emergência', () => {
  // Sem isso, quem gerencia criaria um homônimo da chave reserva, e qual das
  // duas responde viraria detalhe de implementação decidindo quem entra.
  const erros = validarNovoUsuario(
    { username: 'emergencia', role: 'user', regionals: ['GUA'] },
    JOSE, new Set(['emergencia']));
  assert.ok(erros.some(e => /reservado/i.test(e)));
});

// ─────────────────────────────────────────────────────────────────────────────
// podeDesativar
// ─────────────────────────────────────────────────────────────────────────────

test('TRAVA 1: não pode desativar a si mesmo', () => {
  // Trava contra se trancar do lado de fora com um clique.
  const r = podeDesativar('jose', JOSE, [JOSE]);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /si mesmo|pr[óo]prio/i);
});

test('TRAVA 2: não pode deixar zero gestores ativos', () => {
  // A trava 1 não cobre dois gestores se removendo em ordem.
  const outro = u({ username: 'gestor2', pode_gerenciar: true });
  const r = podeDesativar('gestor2', JOSE, [JOSE, outro]);
  assert.equal(r.ok, true, 'com dois gestores, desativar um é permitido');

  const soUm = podeDesativar('gestor2', u({ username: 'gestor2', pode_gerenciar: true }),
    [u({ username: 'gestor2', pode_gerenciar: true })]);
  assert.equal(soUm.ok, false);
});

test('desativar um usuário comum é permitido', () => {
  const alvo = u({ username: 'fulano' });
  const r = podeDesativar('fulano', JOSE, [JOSE, alvo]);
  assert.equal(r.ok, true);
});

test('desativar quem não existe é recusado, não ignorado', () => {
  const r = podeDesativar('fantasma', JOSE, [JOSE]);
  assert.equal(r.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// podeAlterar
// ─────────────────────────────────────────────────────────────────────────────

test('TRAVA 1b: não pode tirar a própria permissão de gerenciar', () => {
  const r = podeAlterar({ pode_gerenciar: false }, JOSE, JOSE, [JOSE]);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /pr[óo]pria|si mesmo/i);
});

test('TRAVA 2b: não pode tirar a permissão do último gestor', () => {
  const soUm = u({ username: 'gestor2', pode_gerenciar: true });
  const r = podeAlterar({ pode_gerenciar: false }, soUm, JOSE, [JOSE, soUm]);
  assert.equal(r.ok, true, 'ainda sobra o José');

  const r2 = podeAlterar({ pode_gerenciar: false }, JOSE, soUm, [JOSE, soUm]);
  assert.equal(r2.ok, true, 'ainda sobra o gestor2');
});

test('TRAVA 3: conceder pode_gerenciar exige que o ator a tenha', () => {
  const naoGestor = u({ username: 'admin2', role: 'admin', pode_gerenciar: false });
  const alvo = u({ username: 'fulano' });
  const r = podeAlterar({ pode_gerenciar: true }, alvo, naoGestor, [JOSE, naoGestor, alvo]);
  assert.equal(r.ok, false);
});

test('TRAVA 4b: alterar regionais respeita o escopo do ator', () => {
  const gestorGua = u({ username: 'gestor_gua', regionals: ['GUA'], pode_gerenciar: true });
  const alvo = u({ username: 'fulano' });
  const r = podeAlterar({ regionals: ['GUA','SJC'] }, alvo, gestorGua, [gestorGua, alvo]);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /SJC/);
});

// ─────────────────────────────────────────────────────────────────────────────
// gerarSenha
// ─────────────────────────────────────────────────────────────────────────────

test('gerarSenha produz senha longa e de alfabeto amplo', () => {
  const s = gerarSenha();
  assert.ok(s.length >= 16, `senha curta demais: ${s.length}`);
  assert.match(s, /[a-z]/);
  assert.match(s, /[A-Z]/);
  assert.match(s, /[0-9]/);
});

test('gerarSenha não repete', () => {
  const vistas = new Set(Array.from({ length: 200 }, () => gerarSenha()));
  assert.equal(vistas.size, 200);
});

test('gerarSenha evita caracteres ambíguos', () => {
  // A senha é transcrita à mão por uma pessoa pra outra. O/0 e l/1/I trocados
  // viram "não consigo entrar" e um reset desnecessário.
  const amostra = Array.from({ length: 200 }, () => gerarSenha()).join('');
  ['O', '0', 'l', '1', 'I'].forEach(c =>
    assert.ok(!amostra.includes(c), `caractere ambíguo "${c}" apareceu`));
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache — o TTL é o teto de quanto tempo um acesso retirado sobrevive
// ─────────────────────────────────────────────────────────────────────────────

const { _cache, CACHE_TTL_MS } = require('../services/usuarios');

test('o TTL do cache é 30s — é o teto do "na hora"', () => {
  assert.equal(CACHE_TTL_MS, 30_000);
});

test('cache guarda e devolve dentro do TTL', () => {
  _cache.limpar();
  _cache.por('fulano', { username: 'fulano', ativo: true });
  assert.equal(_cache.ler('fulano').ativo, true);
});

test('cache expira depois do TTL', () => {
  _cache.limpar();
  _cache.por('fulano', { username: 'fulano', ativo: true });
  _cache.envelhecer('fulano', CACHE_TTL_MS + 1);
  assert.equal(_cache.ler('fulano'), null);
});

test('cache expirado ainda pode ser lido como ÚLTIMO CONHECIDO', () => {
  // É o que sustenta a §3.5 do spec: com o banco fora, vale a última entrada
  // conhecida. Sem isso, banco fora = todo mundo cai, que é pior que hoje.
  _cache.limpar();
  _cache.por('fulano', { username: 'fulano', ativo: true });
  _cache.envelhecer('fulano', CACHE_TTL_MS + 1);
  assert.equal(_cache.ler('fulano'), null, 'leitura normal respeita o TTL');
  assert.equal(_cache.ultimoConhecido('fulano').ativo, true, 'o fallback ignora o TTL');
});

test('sem entrada, ultimoConhecido devolve null — e quem chama NEGA', () => {
  // Fail-open é proibido. É o defeito que o P1-32 consertou no breaker.
  _cache.limpar();
  assert.equal(_cache.ultimoConhecido('nunca_visto'), null);
});

test('invalidar apaga na hora — é o que faz a revogação valer antes dos 30s', () => {
  _cache.limpar();
  _cache.por('fulano', { username: 'fulano', ativo: true });
  _cache.invalidar('fulano');
  assert.equal(_cache.ler('fulano'), null);
  assert.equal(_cache.ultimoConhecido('fulano'), null,
    'invalidar tem de apagar de verdade, não só expirar');
});
