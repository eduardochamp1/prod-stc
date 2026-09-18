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
