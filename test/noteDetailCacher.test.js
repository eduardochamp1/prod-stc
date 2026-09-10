'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const { cachearLote } = require('../services/noteDetailCacher');
const raiz = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// UMA implementação, dois chamadores.
//
// O cron e o backfill fazem "a mesma coisa" — e foi exatamente essa frase que
// produziu o P1-47: `runSyncLogoffs` e `recuperar-logoffs.js` divergiram em
// silêncio e 113 logoffs sumiram. Aqui a duplicação é barrada por teste.
// ─────────────────────────────────────────────────────────────────────────────

test('o cron delega pro módulo em vez de ter o laço próprio', () => {
  const cron = raiz('services/cronService.js');
  assert.match(cron, /require\('\.\/noteDetailCacher'\)/);
  // A assinatura do laço antigo: a chamada direta ao WPA dentro do cron.
  const i = cron.indexOf('async function runCacheNotaDetails');
  const j = cron.indexOf('async function runClassifyNewNotes');
  assert.ok(i > -1 && j > i);
  assert.ok(!/getNoteDetail\(/.test(cron.slice(i, j)),
    'o cron voltou a buscar a nota por conta própria');
});

test('o backfill usa o mesmo módulo', () => {
  const s = raiz('scripts/backfill-note-details.js');
  assert.match(s, /require\('\.\.\/services\/noteDetailCacher'\)/);
  assert.ok(!/getNoteDetail\(/.test(s), 'o backfill reimplementou a busca');
});

test('o backfill não escreve sem --apply', () => {
  const s = raiz('scripts/backfill-note-details.js');
  // A única escrita é `cachearLote`, e ela fica DEPOIS do guard de APPLY.
  const guard = s.indexOf('if (!APPLY)');
  const write = s.indexOf('await cachearLote(');
  assert.ok(guard > -1 && write > guard, 'a gravação não está atrás do --apply');
});

// ─────────────────────────────────────────────────────────────────────────────
// A contagem — é ela que responde "falta backfill?" ou "o dado não existe?"
// ─────────────────────────────────────────────────────────────────────────────

test('separa gravadas, falhas e gravadas SEM checkpoint', async () => {
  const lote = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const r = await cachearLote(lote, {
    concorrencia: 2,
    fn: async c => ({
      a: { ok: true,  id: 'a', checkpoints: 3 },
      b: { ok: true,  id: 'b', checkpoints: 0 },   // gravou, mas sem checkpoint
      c: { ok: false, id: 'c', reason: 'WPA payload vazio' },
      d: { ok: true,  id: 'd', checkpoints: 1 },
    }[c.id]),
  });
  assert.equal(r.ok, 3);
  assert.equal(r.falha, 1);
  // ⚠️ semCp conta só entre as GRAVADAS. Somar a falha aqui esconderia que a
  // nota nem chegou — que é problema de outra natureza.
  assert.equal(r.semCp, 1);
  assert.deepEqual(r.erros, ['c: WPA payload vazio']);
});

test('lote vazio não quebra e não chama nada', async () => {
  let chamou = 0;
  const r = await cachearLote([], { fn: async () => { chamou++; return { ok: true }; } });
  assert.equal(chamou, 0);
  assert.deepEqual(r, { ok: 0, falha: 0, semCp: 0, erros: [] });
});

test('o progresso reporta o total real, não o tamanho do chunk', async () => {
  const vistos = [];
  await cachearLote([{ id: '1' }, { id: '2' }, { id: '3' }], {
    concorrencia: 2,
    fn: async c => ({ ok: true, id: c.id, checkpoints: 1 }),
    onProgresso: p => vistos.push(`${p.feitos}/${p.total}`),
  });
  // O último chunk tem 1 item, mas `feitos` não pode passar do total.
  assert.deepEqual(vistos, ['2/3', '3/3']);
});

// ─────────────────────────────────────────────────────────────────────────────
// --recachear: o modo que sobrescreve
//
// 10/09/2026: o backfill comum preencheu 289 notas e a lacuna das regras quase
// não se mexeu. `registradoEm` só existe em payload gravado a partir de
// 30/08/2026 — o que faltava não era nota, era VERSÃO de payload. Este é o
// único caminho do script que reescreve o que já está no banco, então tem de
// ser explícito e não pode se confundir com o modo normal.
// ─────────────────────────────────────────────────────────────────────────────

test('--recachear seleciona payload velho, não o que falta', () => {
  const s = raiz('scripts/backfill-note-details.js');
  assert.match(s, /const RECACHE = tem\('recachear'\)/);
  // Os dois conjuntos têm de vir de funções DIFERENTES: reusar `faltando`
  // no modo recache não devolveria nada (a nota está lá).
  assert.match(s, /RECACHE\s*\n?\s*\?\s*await payloadsVelhos/);
  assert.match(s, /:\s*await faltando\(todosIds\)/);
});

test('o seletor de payload velho testa registradoEm, não a data do fetch', () => {
  const s = raiz('scripts/backfill-note-details.js');
  const i = s.indexOf('async function payloadsVelhos');
  const bloco = s.slice(i, s.indexOf('\n}', i));
  // `fetched_at < 30/08` seria a régua errada: nota buscada depois pode ter
  // sido gravada por código velho, e o que importa é o CONTEÚDO.
  assert.ok(!/fetched_at/.test(bloco), 'a régua virou data de fetch');
  assert.match(bloco, /registradoEm/);
  // Só faz sentido re-buscar quem TEM checkpoint: sem checkpoint, o payload
  // novo também não teria `registradoEm`, e a chamada seria desperdício.
  assert.match(bloco, /jsonb_array_length\(payload->'checkpoints'\) > 0/);
});

test('recachear continua atrás do --apply', () => {
  const s = raiz('scripts/backfill-note-details.js');
  assert.ok(s.indexOf('if (!APPLY)') < s.indexOf('await cachearLote('));
});
