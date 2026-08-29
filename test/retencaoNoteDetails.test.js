/**
 * test/retencaoNoteDetails.test.js
 *
 * P2-18 / SPEC-retencao-note-details-2026-08-28.
 *
 * `cleanOldNoteDetails` apagava tudo com mais de 90 dias. `note_details` é a
 * ÚNICA fonte dos checkpoints (aba Deslocamento) e das datas de emissão e
 * conclusão (TMA), e não é backfillável — recuperar exigiria 1 request por nota
 * em meses passados, na conta da EDP que bloqueia após 5 falhas de login.
 * Quando isso foi medido (28/08/2026), ~19 dias de detalhes já tinham sido
 * apagados para sempre.
 *
 * A retenção passou a ser configurável e ILIMITADA por padrão, no mesmo molde de
 * SNAPSHOT_RETENTION_DAYS.
 *
 * O que estes testes protegem é a ASSIMETRIA da decisão: errar para ilimitado
 * custa disco (1,15 GB/ano, medido), errar para o outro lado custa histórico
 * irrecuperável. Então TUDO que não for inteiro positivo tem de significar
 * "nunca apaga" — nunca "apague tudo".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { _diasDeRetencao } = require('../services/dataWriter');
const { dateBRTMinusDays } = require('../services/timeUtil');

// ─────────────────────────────────────────────────────────────────────────────
// §5.1 e §5.2 — ausente e 0 significam ilimitado
// ─────────────────────────────────────────────────────────────────────────────

test('variável ausente → retenção ilimitada', () => {
  assert.equal(_diasDeRetencao(undefined), 0);
});

test('string vazia (o `NOTE_DETAILS_RETENTION_DAYS=` do .env.example) → ilimitada', () => {
  // É assim que a chave aparece no .env.example: presente e vazia. dotenv
  // entrega '' e não undefined, então este caso é o do arquivo de exemplo
  // copiado sem edição — o mais provável de acontecer na prática.
  assert.equal(_diasDeRetencao(''), 0);
});

test('0 é "ilimitado", NÃO "apague tudo"', () => {
  // A confusão que mais assusta neste tipo de flag: ler 0 como "0 dias de
  // retenção" apagaria a tabela inteira na primeira madrugada.
  assert.equal(_diasDeRetencao('0'), 0);
  assert.equal(_diasDeRetencao(0), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.3 — valor válido liga a limpeza e o cutoff é o esperado
// ─────────────────────────────────────────────────────────────────────────────

test('valor válido vem como STRING do .env e é aceito', () => {
  // dotenv sempre entrega string. Se a guarda comparasse sem converter, '90'
  // seria truthy e o cutoff viraria NaN.
  assert.equal(_diasDeRetencao('90'), 90);
  assert.equal(_diasDeRetencao(90), 90);
});

test('o cutoff de 90 dias bate com dateBRTMinusDays(90)', () => {
  const dias = _diasDeRetencao('90');
  const cutoff = dateBRTMinusDays(dias) + 'T00:00:00.000Z';
  assert.equal(cutoff, dateBRTMinusDays(90) + 'T00:00:00.000Z');
  assert.match(cutoff, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.4 — o teste que importa: valor inválido NÃO pode virar "apague tudo"
// ─────────────────────────────────────────────────────────────────────────────

test('valor inválido → ilimitado, jamais 0 dias de retenção', () => {
  for (const ruim of ['abc', 'null', 'true', '  ', 'sim', '-1', '-90', 'NaN']) {
    assert.equal(
      _diasDeRetencao(ruim), 0,
      `_diasDeRetencao(${JSON.stringify(ruim)}) tinha de ser 0 (ilimitado)`,
    );
  }
});

test('negativo não vira cutoff no FUTURO (apagaria tudo, inclusive hoje)', () => {
  // Sem a guarda, dateBRTMinusDays(-30) devolveria uma data 30 dias à frente e o
  // delete levaria a tabela inteira. Este é o pior desfecho possível do arquivo.
  assert.equal(_diasDeRetencao('-30'), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.5 — a guarda existe no caminho de código, e o .env.example avisa
// ─────────────────────────────────────────────────────────────────────────────

test('cleanOldNoteDetails sai ANTES de tocar o banco quando é ilimitado', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'dataWriter.js'), 'utf8');
  const corpo = src.slice(
    src.indexOf('async function cleanOldNoteDetails'),
    src.indexOf('Aproveitamento de carteira POR EQUIPE'),
  );
  assert.ok(corpo.length > 0, 'não achei o corpo de cleanOldNoteDetails');

  const iGuarda = corpo.indexOf('_diasDeRetencao');
  const iReturn = corpo.indexOf('return;');
  const iClient = corpo.indexOf('getClient()');
  assert.ok(iGuarda > -1, 'a guarda de retenção sumiu de cleanOldNoteDetails');
  assert.ok(iReturn > -1 && iReturn < iClient,
    'o return da guarda tem de vir ANTES de getClient() — senão abre conexão à toa');
  assert.ok(!/dateBRTMinusDays\(90\)/.test(corpo),
    'o TTL fixo de 90 dias voltou — tem de vir de NOTE_DETAILS_RETENTION_DAYS');
});

test('.env.example marca a chave nova como destrutiva e ilimitada por padrão', () => {
  // Espelha o teste que já existe pra SNAPSHOT_RETENTION_DAYS (P1-44): a chave
  // que apaga dado irrecuperável tem de gritar isso pra quem abre o arquivo.
  const src = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const i = src.indexOf('NOTE_DETAILS_RETENTION_DAYS');
  assert.ok(i > -1, 'NOTE_DETAILS_RETENTION_DAYS tem de estar no .env.example');

  const bloco = src.slice(Math.max(0, i - 1200), i);
  assert.match(bloco, /DESTRUTIVO/, 'precisa do aviso de destrutivo');
  assert.match(bloco, /ILIMITADA/, 'precisa dizer que ausente = retenção ilimitada');
  assert.match(bloco, /backfill|recuperar/i,
    'precisa dizer que o dado NÃO volta — é o que diferencia esta chave de um TTL comum');
});
