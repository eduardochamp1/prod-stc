'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const { ehRetornoBase, retornoDaSessao, msParede } = require('../db/heQueries');

// ─────────────────────────────────────────────────────────────────────────────
// O apontamento 29 — "Retorno da equipe à base".
//
// Em 09/09/2026 eu escrevi em `heQueries.js` que "NÃO EXISTE DADO DE BASE NO
// SISTEMA" e entreguei a coluna com uma régua inferida (fim do trabalho da
// última nota → logoff). O José corrigiu em 10/09: existe apontamento próprio,
// e ele entra nos apontamentos da SESSÃO.
//
// Números medidos no banco em 10/09/2026, período 22/08–09/09 — são eles que
// justificam cada caso testado aqui:
//   1135  '29 - Retorno da equipe à base'   (com o código)
//    670  'Retorno da equipe à base'        (SEM o código — 37% do total)
//     17  sem hora de fim (apontamento em aberto)
// ─────────────────────────────────────────────────────────────────────────────

test('reconhece o apontamento COM e SEM o codigo', () => {
  // As duas formas convivem no banco. Casar por igualdade de string, ou exigir
  // o prefixo '29', perderia 670 de 1805 apontamentos.
  assert.equal(ehRetornoBase('29 - Retorno da equipe à base'), true);
  assert.equal(ehRetornoBase('Retorno da equipe à base'), true);
  assert.equal(ehRetornoBase('  29 - RETORNO DA EQUIPE À BASE  '), true);
});

test('nao confunde com outros apontamentos que falam de retorno', () => {
  // Este existe de verdade no catálogo e tem 8 ocorrências no período.
  assert.equal(ehRetornoBase('40 - Falta de Material - Retorno ao Almoxarifado'), false);
  assert.equal(ehRetornoBase('15 - Horário de Refeição'), false);
  assert.equal(ehRetornoBase('11 - Deslocamento para Refeição'), false);
  assert.equal(ehRetornoBase(null), false);
  assert.equal(ehRetornoBase(''), false);
});

test('o numero sozinho nao decide — o texto e que identifica', () => {
  // Se a EDP reusar o código 29 pra outra coisa, o texto protege.
  assert.equal(ehRetornoBase('29 - Qualquer outra coisa'), false);
});

test('pega o ULTIMO retorno do dia, nao o primeiro', () => {
  // A equipe pode voltar à base no meio do dia (carregar material) e sair de
  // novo. O que fecha o dia é o último — foi o pedido literal do José:
  // "o horario e o tempo do ultimo deslocamento para a base".
  const r = retornoDaSessao([
    { motivo: '29 - Retorno da equipe à base', inicio: '2026-09-09T10:00:00', fim: '2026-09-09T10:20:00' },
    { motivo: 'Retorno da equipe à base',      inicio: '2026-09-09T16:29:00', fim: '2026-09-09T17:07:00' },
    { motivo: '15 - Horário de Refeição',      inicio: '2026-09-09T12:00:00', fim: '2026-09-09T13:00:00' },
  ]);
  assert.equal(r.inicioMs, msParede('2026-09-09T16:29:00'));
  assert.equal(r.duracaoMin, 38);
  assert.equal(r.emAberto, false);
});

test('apontamento em aberto: horario sim, duracao NAO', () => {
  // 17 de 1135 no período. Fechar com o logoff daria um número plausível e
  // falso — a planilha vai pra EDP, e estimativa não pode ir na coluna de
  // medição. null diz "não sei", que é a verdade.
  const r = retornoDaSessao([
    { motivo: '29 - Retorno da equipe à base', inicio: '2026-09-09T16:40:00', fim: null },
  ]);
  assert.equal(r.duracaoMin, null);
  assert.equal(r.emAberto, true);
  assert.equal(r.inicioMs, msParede('2026-09-09T16:40:00'));
});

test('fim ANTES do inicio e dado inconsistente, nao duracao negativa', () => {
  const r = retornoDaSessao([
    { motivo: 'Retorno da equipe à base', inicio: '2026-09-09T17:00:00', fim: '2026-09-09T16:00:00' },
  ]);
  assert.equal(r.duracaoMin, null);
});

test('sem apontamento de retorno devolve null', () => {
  assert.equal(retornoDaSessao([{ motivo: '06 - Check List', inicio: '2026-09-09T07:00:00' }]), null);
  assert.equal(retornoDaSessao([]), null);
  assert.equal(retornoDaSessao(null), null);
});

test('retorno que atravessa a meia-noite conta certo', () => {
  // Turno C17 (17:00→02:00) e família — o vira-noite não é hipótese aqui.
  const r = retornoDaSessao([
    { motivo: '29 - Retorno da equipe à base', inicio: '2026-09-09T23:40:00', fim: '2026-09-10T00:25:00' },
  ]);
  assert.equal(r.duracaoMin, 45);
});

// ─────────────────────────────────────────────────────────────────────────────
// O FUSO — a parte que vale R$ 1.128 por linha se sair errada.
//
// `sessao_intervalo.inicio` é TIMESTAMPTZ e o normalizador anexa 'Z'
// (`wpaService.js:949`). Medido em 10/09/2026 com a refeição como oráculo:
// 1368 de 1765 almoços caem entre 11h e 14h lendo o instante como PAREDE,
// contra 393 lendo como UTC. E na amostra do 29 o fim do retorno bate no
// logoff ao minuto (ECACH50: fim 17:52, logoff 17:52).
// ─────────────────────────────────────────────────────────────────────────────

test('a consulta DESFAZ o Z anexado na coleta', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'db', 'heQueries.js'), 'utf8');
  const i = SRC.indexOf('async function _aplicarRetornoBase');
  assert.ok(i > -1, 'nao achei _aplicarRetornoBase');
  const bloco = SRC.slice(i, i + 3000);
  // `AT TIME ZONE 'UTC'` sobre um timestamptz devolve a parede que a EDP
  // mandou. `America/Sao_Paulo` aqui tiraria mais 3h e erraria o dia inteiro.
  assert.match(bloco, /AT TIME ZONE 'UTC'/);
  assert.ok(!/AT TIME ZONE 'America\/Sao_Paulo'/.test(bloco),
    'converter pra BRT aqui reintroduz o erro de 3h');
  // E o texto tem de sair formatado do banco: deixar o driver devolver Date
  // traria fuso de volta pela porta dos fundos.
  assert.match(bloco, /to_char\(inicio AT TIME ZONE/);
});

test('a regra 2 saiu do laco de checkpoints', () => {
  // Se as duas fontes voltarem a coexistir, uma sobrescreve a outra em
  // silêncio e ninguém sabe qual número foi pra planilha.
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'db', 'heQueries.js'), 'utf8');
  const i = SRC.indexOf('async function _aplicarAcordo30');
  const j = SRC.indexOf('function _diaMais');
  assert.ok(i > -1 && j > i);
  const bloco = SRC.slice(i, j);
  assert.ok(!/deslocBase\(/.test(bloco),
    'a regua inferida voltou pro laco do acordo 30');
});

// ─────────────────────────────────────────────────────────────────────────────
// HOJE NÃO É LACUNA.
//
// `runSyncIntervalos` roda às 03:10 sobre D-1, então o dia corrente sempre
// aparece sem intervalo. No print de 10/09/2026 o aviso acusou "22 linhas em
// dia SEM coleta" e mandou rodar backfill — e o único dia afetado era o
// próprio dia de hoje. É a mesma armadilha do P1-47, quando eu mandei conferir
// um período que incluía hoje e 35 de 40 sessões "abertas" eram turnos em
// curso.
// ─────────────────────────────────────────────────────────────────────────────

test('o dia corrente e contado como PENDENTE, nao como lacuna', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'db', 'heQueries.js'), 'utf8');
  const i = SRC.indexOf('async function _aplicarRetornoBase');
  const bloco = SRC.slice(i, SRC.indexOf('/** FUNÇÃO PURA: ms de parede', i));
  assert.match(bloco, /coletaPendente/);
  // A comparação tem de ser com o dia BRT, não com o relógio do processo (a VM
  // roda em UTC: depois das 21h, `new Date()` já está no dia seguinte).
  assert.match(bloco, /dateBRT\(\)/);
  assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(bloco),
    'usar o relogio do processo vira dia errado na VM em UTC');
});

test('a tela separa "pendente hoje" de "sem coleta"', () => {
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(HTML, /r\.base_coleta_pendente/);
  const i = HTML.indexOf('r.base_coleta_pendente');
  const bloco = HTML.slice(i, i + 600);
  // O aviso de hoje NAO pode mandar rodar backfill.
  assert.ok(!/backfill-intervalos/.test(bloco),
    'o aviso de hoje esta pedindo backfill do proprio dia');
});
