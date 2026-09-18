/**
 * test/equipesImportRota.test.js
 *
 * Contrato das rotas de equipes oficiais: o GET tem de devolver `setor`, e a
 * importação em lote tem de validar do lado que grava.
 *
 * Estes testes leem o código-fonte — provam a FORMA. O comportamento por HTTP
 * (401/403/400) está em test/equipesImportHttp.test.js.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROTAS = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');

test('GET /admin/equipes seleciona a coluna setor', () => {
  // Sem `setor` no SELECT, a tabela do Admin mostra "—" pra todas as equipes e
  // o formulário reescreve o setor ao salvar (fallback do index.html:9481).
  // E montarPlano veria TODA equipe existente como "setor mudando".
  const i = ROTAS.indexOf('const _COLS_BASE');
  assert.ok(i > -1, 'não achei _COLS_BASE em routes/index.js');
  const bloco = ROTAS.slice(i, i + 300);
  assert.ok(
    /\bsetor\b/.test(bloco),
    `_COLS_BASE precisa incluir "setor". Bloco atual:\n${bloco.slice(0, 200)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/equipes/importar — forma do handler
// ─────────────────────────────────────────────────────────────────────────────

test('a rota de importação existe e fica sob /admin (requireAdmin)', () => {
  assert.ok(
    ROTAS.includes("router.post('/admin/equipes/importar'"),
    'não achei POST /admin/equipes/importar em routes/index.js'
  );
  // O guard é o router.use('/admin', requireAdmin) — qualquer rota sob /admin
  // herda. Este teste trava o prefixo: mudar pra /equipes/... tiraria a rota
  // de baixo do guard sem ninguém notar.
  assert.ok(ROTAS.includes("router.use('/admin', requireAdmin)"));
});

test('o apply RECALCULA o plano — não confia no que o cliente mandou', () => {
  const i = ROTAS.indexOf("router.post('/admin/equipes/importar'");
  const bloco = ROTAS.slice(i, i + 2600);
  assert.ok(
    bloco.includes('montarPlano('),
    'o handler tem de chamar montarPlano no servidor, nas duas fases'
  );
  assert.ok(
    !/req\.body\.plano/.test(bloco),
    'o handler não pode usar um plano vindo do cliente'
  );
});

test('dryRun é o padrão seguro: só grava com dryRun === false explícito', () => {
  const i = ROTAS.indexOf("router.post('/admin/equipes/importar'");
  const bloco = ROTAS.slice(i, i + 2600);
  assert.ok(
    /dryRun\s*!==\s*false/.test(bloco),
    'payload sem dryRun tem de cair na prévia, nunca na gravação'
  );
});

test('a gravação é UM upsert, não um laço de inserts', () => {
  // É o que sustenta a atomicidade: o pgShim não tem transação (nenhum BEGIN,
  // nenhum pool.connect), então o lote só é tudo-ou-nada por ser um statement
  // único. Trocar por N inserts quebraria isso em silêncio.
  const i = ROTAS.indexOf("router.post('/admin/equipes/importar'");
  const bloco = ROTAS.slice(i, i + 2600);
  assert.ok(bloco.includes(".upsert(rows, { onConflict: 'sigla' })"));
  assert.ok(!/for\s*\(.*\)\s*\{[^}]*\.insert\(/s.test(bloco),
    'não pode existir laço de insert por linha');
});

test('a importação chama forceRefresh depois de gravar', () => {
  const i = ROTAS.indexOf("router.post('/admin/equipes/importar'");
  const bloco = ROTAS.slice(i, i + 2600);
  assert.ok(bloco.includes('forceRefresh'),
    'sem isso o cache de 60s serve a whitelist velha depois da importação');
});
