/**
 * test/deslocTruncamento.test.js
 *
 * A aba Deslocamento truncava o período em SILÊNCIO. Medido em produção em
 * 28/08/2026 (perfil admin, 01/08 → 27/08):
 *
 *   passo 1: 20000 notas com checkpoint       ← existiam 24.610 no banco
 *   passo 4: 21852 deslocamentos extraídos, processando 20000
 *
 * Dois cortes empilhados — 4.610 notas e mais 1.852 deslocamentos — e nada na
 * tela dizendo isso. Com `ORDER BY first_ts DESC`, o que sai é sempre o COMEÇO do
 * período. KPIs, ranking e tendência eram calculados sobre esse recorte.
 *
 * O repo não tem harness de frontend nem banco de teste, então aqui valem as
 * invariantes que dão pra provar lendo o código — no estilo do resto da suíte
 * (assert puro, sem framework). O que elas pegam é o modo de falha real: os dois
 * tetos voltarem a divergir, ou a leitura cara do jsonb voltar pro passo 1.
 *
 * Limite explícito: isto NÃO prova que a aba carrega. A conferência de tela é
 * manual, no navegador.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desloc = require('../db/deslocamentosQueries');

const SRC_DB    = fs.readFileSync(path.join(__dirname, '..', 'db', 'deslocamentosQueries.js'), 'utf8');
const SRC_FRONT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Os dois tetos têm de concordar
// ─────────────────────────────────────────────────────────────────────────────

test('o `limit` que o front manda cabe no teto do backend', () => {
  const m = SRC_FRONT.match(/qs\.set\('limit',\s*'(\d+)'\)/);
  assert.ok(m, 'deslocFiltersQuery deveria mandar `limit` na querystring');

  const doFront = Number(m[1]);
  assert.ok(Number.isFinite(desloc.MAX_NOTAS_PERIODO), 'backend deveria exportar MAX_NOTAS_PERIODO');
  // IGUALDADE, não "menor ou igual": o `limit` entra no _key do memoCache. Se o
  // front pedir um número e as rotas derivadas usarem outro, as chaves param de
  // colidir e o pipeline caro roda 3x em paralelo de novo (o bug de 21/08).
  assert.equal(
    doFront, desloc.MAX_NOTAS_PERIODO,
    `front pede ${doFront} e o backend usa ${desloc.MAX_NOTAS_PERIODO} — `
    + 'chaves de cache divergem e o single-flight se desfaz',
  );
});

test('ranking e tendência usam a MESMA constante que a lista', () => {
  // Sem isto, /ranking e /tendencia geram chave própria: 3 pipelines em vez de 1,
  // e o ranking calculado sobre uma lista mais curta que a dos KPIs.
  const derivadas = SRC_DB.match(/_listCached \|\| listDeslocamentos\)\([^)]*\{[^}]*\}/g) || [];
  assert.equal(derivadas.length, 2, `esperava 2 chamadas derivadas, achei ${derivadas.length}`);
  for (const d of derivadas) {
    assert.ok(
      /limit:\s*MAX_NOTAS_PERIODO/.test(d),
      `chamada derivada com limit solto em vez da constante:\n${d}`,
    );
  }
});

test('o teto cobre o volume real medido em 28/08/2026', () => {
  // 24.610 notas / 21.852 deslocamentos num período de 27 dias. Um teto abaixo
  // disso volta a truncar o uso NORMAL da aba, que é o bug que esta mudança
  // conserta. Folga proposital: o teto é válvula contra OOM, não regra de
  // produto.
  assert.ok(
    desloc.MAX_NOTAS_PERIODO >= 25000,
    `MAX_NOTAS_PERIODO=${desloc.MAX_NOTAS_PERIODO} corta o volume já observado em produção`,
  );
});

test('a query do passo 1 não tem mais LIMIT embutido', () => {
  // O `LIMIT 20000` literal era o corte invisível. Agora o teto é a constante —
  // um número só, exportado, testável e citado no log quando é atingido.
  // Olha só o template SQL — os comentários do arquivo citam o "LIMIT 20000"
  // antigo de propósito, como arqueologia do incidente, e não podem quebrar isto.
  const sqlNotas = SRC_DB.slice(
    SRC_DB.indexOf('const sqlNotas'),
    SRC_DB.indexOf('const { rows: rawNotas }'),
  );
  assert.ok(sqlNotas.length > 0, 'não achei o template sqlNotas');
  assert.ok(
    !/LIMIT\s+\d+/.test(sqlNotas),
    'o passo 1 voltou a ter um LIMIT numérico embutido na query',
  );
  assert.ok(
    /LIMIT \$\{MAX_NOTAS_PERIODO\}/.test(sqlNotas),
    'o passo 1 deveria usar a constante MAX_NOTAS_PERIODO no LIMIT',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Truncar é aceitável; truncar calado, não
// ─────────────────────────────────────────────────────────────────────────────

test('todo retorno de listDeslocamentos carrega `truncado`', () => {
  // Inclusive os retornos curtos (período vazio, nenhuma nota da equipe). Se um
  // deles esquecer o campo, a tela lê `undefined`, não mostra aviso, e volta o
  // silêncio — que é exatamente o bug.
  const corpo = SRC_DB.slice(
    SRC_DB.indexOf('async function listDeslocamentos'),
    SRC_DB.indexOf('/** Ranking de equipes'),
  );
  const returns = corpo.match(/return \{[\s\S]*?\};/g) || [];
  assert.ok(returns.length >= 3, `esperava ao menos 3 returns, achei ${returns.length}`);
  for (const r of returns) {
    assert.ok(/truncado:/.test(r), `return sem campo truncado:\n${r}`);
  }
});

test('a tela avisa quando o backend diz que truncou', () => {
  assert.ok(
    /lista\s*&&\s*lista\.truncado/.test(SRC_FRONT),
    'renderDeslocamentos deveria checar lista.truncado',
  );
  assert.ok(
    /Período incompleto/.test(SRC_FRONT),
    'faltou o aviso visível de período incompleto',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// O jsonb caro só depois de saber de quem é a nota
// ─────────────────────────────────────────────────────────────────────────────

test('o passo 1 não lê checkpoints — quem lê é o 3b, já filtrado', () => {
  const passo1 = SRC_DB.slice(SRC_DB.indexOf('const sqlNotas'), SRC_DB.indexOf('const { rows: rawNotas }'));
  assert.ok(
    !/payload->'checkpoints'\s+AS\s+checkpoints/.test(passo1),
    'o passo 1 voltou a puxar o payload — é o detoast que esta mudança evita',
  );
  assert.ok(
    /sqlPayloads/.test(SRC_DB) && /note_id = ANY\(\$1::uuid\[\]\)/.test(SRC_DB),
    'faltou o passo 3b buscando checkpoints só das notas que sobreviveram',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Geometria fora da resposta
// ─────────────────────────────────────────────────────────────────────────────

test('a resposta não carrega mais a geometria de cada deslocamento', () => {
  assert.ok(
    !/^\s*d\.geometry\s*=/m.test(SRC_DB),
    'd.geometry voltou pra resposta — são 20k LineStrings que ninguém consome',
  );
});

test('o osrm_cache continua guardando geometria (o backfill depende disso)', () => {
  const osrm = fs.readFileSync(path.join(__dirname, '..', 'services', 'osrmService.js'), 'utf8');
  assert.ok(/geometry:\s*payload\.geometry/.test(osrm), 'o cache parou de gravar geometry');
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressão do que já estava certo
// ─────────────────────────────────────────────────────────────────────────────

test('as 3 rotas continuam compartilhando UM cálculo', () => {
  // Correção de 21/08/2026: /lista, /ranking e /tendencia rodam em paralelo com
  // os mesmos filtros. As derivadas chamam a lista CACHEADA, e a chave tem de
  // bater — senão o pipeline caro roda 3x, que foi o bug original.
  const daLista = desloc._key('list', '2026-08-01', '2026-08-27', { limit: '60000', regionais: ['GUA'] });
  const daDerivada = desloc._key('list', '2026-08-01', '2026-08-27', { limit: 60000, regionais: ['GUA'] });
  assert.equal(daLista, daDerivada, 'string da querystring x número interno voltaram a divergir');
});
