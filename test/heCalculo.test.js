/**
 * test/heCalculo.test.js
 *
 * Fase 2 da SPEC-medicao-he-2026-09-09 — o cálculo da hora extra.
 *
 * ⚠️ O QUE ESTÁ EM JOGO: cada minuto aqui vale entre R$ 2,04 (L0M) e R$ 6,27
 * (A2). Um erro de fuso são 3 horas = até R$ 1.128 por linha. Um erro de
 * arredondamento são centavos por linha × ~327 linhas/mês.
 *
 * Os casos marcados "print" vêm dos números impressos de 09/09/2026. Onde o
 * print não mostra segundos, eles são RECONSTRUÍDOS das outras colunas da mesma
 * linha e o comentário diz como — ver FIM_18_07. Precisão inventada aqui já
 * fez o teste acusar o código de um erro que era do teste.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  msParede, normHora, janelaDaEscala, janelaMaisAmpla, sessaoDoDia,
  calcularHe, valorTotalHe, temHe, rotuloUltimaNota, ultimaNotaDaSessao,
  fmtParede, montarLinhaHe,
} = require('../db/heQueries');

const H = 3600000;

// ─────────────────────────────────────────────────────────────────────────────
// Leitura de instante — a armadilha de 3 horas
// ─────────────────────────────────────────────────────────────────────────────

test('sem marcador de fuso, lê a parede como está', () => {
  // É o formato que o WPA devolve em session_begin/session_end. Converter
  // erraria 3h e a VM roda em UTC, então o bug não apareceria em dev.
  const a = msParede('2026-07-18T20:00:00');
  const b = msParede('2026-07-18T20:43:08');
  assert.equal((b - a) / 60000, 43 + 8 / 60);
});

test('aceita milissegundos e espaço em vez de T', () => {
  assert.equal(msParede('2026-08-30T14:43:58.957') - msParede('2026-08-30T14:43:58'), 957);
  assert.equal(msParede('2026-07-18 20:00:00'), msParede('2026-07-18T20:00:00'));
});

test('offset -03:00 é BRT — não desloca nada', () => {
  assert.equal(msParede('2026-07-18T20:43:08-03:00'), msParede('2026-07-18T20:43:08'));
});

test('Z e +00:00 são UTC — viram parede BRT', () => {
  // Se a EDP mudar o formato pra UTC, isto impede a leitura errada silenciosa.
  assert.equal(msParede('2026-07-18T23:43:08Z'), msParede('2026-07-18T20:43:08'));
  assert.equal(msParede('2026-07-18T23:43:08+00:00'), msParede('2026-07-18T20:43:08'));
});

test('string ilegível devolve null, não NaN nem 0', () => {
  for (const v of [null, undefined, '', 'sei lá', '18/07/2026 20:00', '2026-07-18']) {
    assert.equal(msParede(v), null, JSON.stringify(v));
  }
});

test('normHora aceita os formatos do pg e rejeita hora inválida', () => {
  assert.equal(normHora('08:00'), '08:00:00');
  assert.equal(normHora('22:35:00'), '22:35:00');
  assert.equal(normHora('8:00'), '08:00:00');
  assert.equal(normHora('25:00'), null);
  assert.equal(normHora('12:99'), null);
  assert.equal(normHora(null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Janela da escala — vira-noite
// ─────────────────────────────────────────────────────────────────────────────

test('turno normal fecha no mesmo dia', () => {
  const j = janelaDaEscala('2026-07-18', '11:00', '20:00');
  assert.equal((j.fimMs - j.inicioMs) / H, 9);
});

test('C35 (22:35→06:00) fecha no dia SEGUINTE', () => {
  const j = janelaDaEscala('2026-08-30', '22:35', '06:00');
  assert.equal((j.fimMs - j.inicioMs) / H, 7 + 25 / 60);
  assert.equal(fmtParede(j.fimMs), '2026-08-31 06:00:00');
});

test('C17 (17:00→02:00) também', () => {
  const j = janelaDaEscala('2026-08-30', '17:00', '02:00');
  assert.equal((j.fimMs - j.inicioMs) / H, 9);
  assert.equal(fmtParede(j.fimMs), '2026-08-31 02:00:00');
});

test('janela ambígua (fim == início) devolve null — não adivinha 24h', () => {
  // Mesma regra de escalaQueries.turnoCobreAgora. Assumir 24h daria uma escala
  // que nunca é extrapolada, e a hora extra do dia sumiria.
  assert.equal(janelaDaEscala('2026-07-18', '08:00', '08:00'), null);
});

test('data ou hora inválida devolve null', () => {
  assert.equal(janelaDaEscala('18/07/2026', '08:00', '17:00'), null);
  assert.equal(janelaDaEscala('2026-07-18', null, '17:00'), null);
  assert.equal(janelaDaEscala('2026-07-18', '08:00', '99:00'), null);
});

test('com dois códigos no dia, vale a janela MAIS AMPLA', () => {
  // Escala mais larga = menos hora extra. Na dúvida, subnotificar a favor da
  // EDP; cobrar hora que talvez não exista é o erro caro.
  const j = janelaMaisAmpla('2026-07-18', [
    { inicio_escala: '08:00', fim_escala: '17:00' },
    { inicio_escala: '11:00', fim_escala: '20:00' },
  ]);
  assert.equal(fmtParede(j.inicioMs), '2026-07-18 08:00:00');
  assert.equal(fmtParede(j.fimMs),    '2026-07-18 20:00:00');
});

test('janelaMaisAmpla ignora par inválido em vez de estourar', () => {
  const j = janelaMaisAmpla('2026-07-18', [
    { inicio_escala: '08:00', fim_escala: '08:00' },   // ambígua
    { inicio_escala: '11:00', fim_escala: '20:00' },
  ]);
  assert.equal(fmtParede(j.inicioMs), '2026-07-18 11:00:00');
  assert.equal(janelaMaisAmpla('2026-07-18', []), null);
  assert.equal(janelaMaisAmpla('2026-07-18', null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sessão do dia — relogin
// ─────────────────────────────────────────────────────────────────────────────

test('relogin vira UMA sessão: primeiro login, último logoff', () => {
  // Somar as duas em separado cobraria duas antecipações pela mesma manhã.
  const s = sessaoDoDia([
    { begin: '2026-07-18T11:00:00', end: '2026-07-18T15:30:00' },
    { begin: '2026-07-18T15:45:00', end: '2026-07-18T20:43:08' },
  ]);
  assert.equal(fmtParede(s.inicioMs), '2026-07-18 11:00:00');
  assert.equal(fmtParede(s.fimMs),    '2026-07-18 20:43:08');
  assert.equal(s.relogins, 1);
});

test('sessão ABERTA devolve fim null — não inventa logoff', () => {
  const s = sessaoDoDia([{ begin: '2026-07-18T11:00:00', end: null }]);
  assert.equal(s.fimMs, null);
  assert.equal(fmtParede(s.inicioMs), '2026-07-18 11:00:00');
});

test('uma sessão aberta entre várias contamina o fim, de propósito', () => {
  // Se alguma sessão do dia não fechou, o "último logoff" é desconhecido.
  // Usar o fim de outra sessão inventaria prorrogação.
  const s = sessaoDoDia([
    { begin: '2026-07-18T11:00:00', end: '2026-07-18T15:30:00' },
    { begin: '2026-07-18T15:45:00', end: null },
  ]);
  assert.equal(s.fimMs, null);
});

test('lista vazia ou sem begin legível devolve null', () => {
  assert.equal(sessaoDoDia([]), null);
  assert.equal(sessaoDoDia(null), null);
  assert.equal(sessaoDoDia([{ begin: 'lixo', end: null }]), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// O cálculo, contra os números da planilha
// ─────────────────────────────────────────────────────────────────────────────

const janela = (d, i, f) => janelaDaEscala(d, i, f);
const sessao = (b, e) => sessaoDoDia([{ begin: b, end: e }]);

// ⚠️ SEGUNDOS RECONSTRUÍDOS, NÃO LIDOS. O print mostra `FIM SESSÃO 20:43` sem
// segundos. Os segundos abaixo saem dos OUTROS números impressos da mesma
// linha, resolvendo as duas restrições ao mesmo tempo:
//     round(x, 3)            = 0,719      (coluna PRORROGAÇÃO)
//     round(x × 376,28, 2)   = R$ 270,36  (coluna VALOR TOTAL)
//   ⇒ x = 0,7185 h = 43 min 6,6 s
// A 1ª versão deste teste usava ":08" chutado por mim e cobrava R$ 270,36 —
// com ":08" o valor correto é R$ 270,50, e o teste acusou o código de um erro
// que era meu. Precisão inventada é a armadilha que este arquivo existe pra
// pegar; ela pegou o próprio autor primeiro.
const FIM_18_07 = '2026-07-18T20:43:06.600';

test('print · 18/07 EPMFL33: 43 min, 0,72 dec e R$ 270,36', () => {
  const he = calcularHe(
    janela('2026-07-18', '11:00', '20:00'),
    sessao('2026-07-18T11:00:00', FIM_18_07));
  assert.equal(he.antecipacao_h, 0);
  assert.equal(he.total_min, 43);
  assert.equal(he.total_dec, 0.72);
  assert.equal(valorTotalHe(he.total_h, 376.28), 270.36);
});

test('print · o valor sai do total CRU, não do arredondado', () => {
  // Com o total_dec (0,72) daria R$ 270,92. A planilha diz R$ 270,36. É a
  // diferença entre usar o valor cru e o arredondado de exibição.
  const he = calcularHe(
    janela('2026-07-18', '11:00', '20:00'),
    sessao('2026-07-18T11:00:00', FIM_18_07));
  assert.equal(valorTotalHe(he.total_dec, 376.28), 270.92);
  assert.equal(valorTotalHe(he.total_h, 376.28), 270.36);
});

test('print · 01/08: 22min exatos = R$ 137,97', () => {
  const he = calcularHe(
    janela('2026-08-01', '11:00', '20:00'),
    sessao('2026-08-01T11:00:00', '2026-08-01T20:22:00'));
  assert.equal(he.total_min, 22);
  assert.equal(valorTotalHe(he.total_h, 376.28), 137.97);
});

test('print · EBGPR64 24/07: sessão fecha 25/07 00:02 → 423 min', () => {
  // O caso que prova o vira-noite. Sem resolver a data, isto daria prorrogação
  // negativa de ~17h.
  const he = calcularHe(
    janela('2026-07-24', '08:00', '17:00'),
    sessao('2026-07-24T08:00:00', '2026-07-25T00:02:56'));
  assert.equal(he.total_min, 423);
  assert.equal(he.total_dec, 7.05);
});

test('print · EBGPR65 24/07: 424 min', () => {
  const he = calcularHe(
    janela('2026-07-24', '08:00', '17:00'),
    sessao('2026-07-24T08:00:00', '2026-07-25T00:03:36'));
  assert.equal(he.total_min, 424);
});

test('antecipação ENTRA no total (decisão de 09/09/2026)', () => {
  const he = calcularHe(
    janela('2026-07-18', '08:00', '17:00'),
    sessao('2026-07-18T07:30:00', '2026-07-18T17:20:00'));
  assert.equal(he.antecipacao_h, 0.5);
  assert.equal(he.prorrogacao_h, 20 / 60);
  assert.equal(he.total_min, 50);
});

test('entrar atrasado não gera antecipação NEGATIVA', () => {
  // Sem o Math.max(0), entrar 40min atrasado anularia 40min de prorrogação e a
  // hora extra desapareceria.
  const he = calcularHe(
    janela('2026-07-18', '08:00', '17:00'),
    sessao('2026-07-18T08:40:00', '2026-07-18T17:40:00'));
  assert.equal(he.antecipacao_h, 0);
  assert.equal(he.total_min, 40);
});

test('sair antes não gera prorrogação negativa', () => {
  const he = calcularHe(
    janela('2026-07-18', '08:00', '17:00'),
    sessao('2026-07-18T08:00:00', '2026-07-18T16:00:00'));
  assert.equal(he.prorrogacao_h, 0);
  assert.equal(he.total_h, 0);
  assert.equal(temHe(he), false, 'dia dentro da escala não vira linha');
});

test('sessão aberta marca incompleta e não inventa prorrogação', () => {
  const he = calcularHe(
    janela('2026-07-18', '08:00', '17:00'),
    sessaoDoDia([{ begin: '2026-07-18T07:30:00', end: null }]));
  assert.equal(he.prorrogacao_h, null);
  assert.equal(he.antecipacao_h, 0.5);
  assert.equal(he.incompleta, true);
  assert.equal(temHe(he), true, 'a antecipação já é hora extra medida');
});

test('calcularHe com entrada faltando devolve null', () => {
  assert.equal(calcularHe(null, sessao('2026-07-18T08:00:00', '2026-07-18T17:00:00')), null);
  assert.equal(calcularHe(janela('2026-07-18', '08:00', '17:00'), null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Valor — sem cadastro é null, NUNCA zero
// ─────────────────────────────────────────────────────────────────────────────

test('sem valor/hora o valor é null, não zero', () => {
  // Zero pareceria "não há o que cobrar". Null aparece vazio e a tela avisa.
  assert.equal(valorTotalHe(1.5, null), null);
  assert.equal(valorTotalHe(1.5, undefined), null);
  assert.equal(valorTotalHe(1.5, 0), null);
  assert.equal(valorTotalHe(1.5, -10), null);
  assert.equal(valorTotalHe(1.5, NaN), null);
});

test('total ausente também devolve null', () => {
  assert.equal(valorTotalHe(null, 376.28), null);
  assert.equal(valorTotalHe(NaN, 376.28), null);
});

test('arredonda em centavos', () => {
  assert.equal(valorTotalHe(1, 122.14), 122.14);
  assert.equal(valorTotalHe(1 / 3, 297.54), 99.18);
});

test('temHe exige uma das pontas > 0', () => {
  assert.equal(temHe({ antecipacao_h: 0, prorrogacao_h: 0 }), false);
  assert.equal(temHe({ antecipacao_h: 0.1, prorrogacao_h: 0 }), true);
  assert.equal(temHe({ antecipacao_h: 0, prorrogacao_h: 0.1 }), true);
  assert.equal(temHe({ antecipacao_h: null, prorrogacao_h: null }), false);
  assert.equal(temHe(null), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Última nota
// ─────────────────────────────────────────────────────────────────────────────

test('rótulo sai no formato da planilha', () => {
  assert.equal(
    rotuloUltimaNota({ tipoCode: 'PO', codigo: '104740451', status: 'executada' }),
    'PO - 104740451 - Executada');
});

test('rótulo tolera campo faltando sem virar "undefined"', () => {
  assert.equal(rotuloUltimaNota({ tipoCode: 'LN', codigo: '123' }), 'LN - 123');
  assert.equal(rotuloUltimaNota({ codigo: '123', status: 'rejeitada' }), '?? - 123 - Rejeitada');
  assert.equal(rotuloUltimaNota(null), null);
});

test('a última nota é a de conclusão mais RECENTE, entre os três buckets', () => {
  const r = ultimaNotaDaSessao({
    notasConcluidas: [{ tipoCode: 'LN', codigo: '1', status: 'concluida', conclusionDate: '2026-07-18T14:00:00' }],
    notasRejeitadas: [{ tipoCode: 'MD', codigo: '2', status: 'rejeitada', conclusionDate: '2026-07-18T19:30:00' }],
    notasExecutadas: [{ tipoCode: 'PO', codigo: '3', status: 'executada', conclusionDate: '2026-07-18T09:00:00' }],
  });
  assert.equal(r.nota.codigo, '2', 'a rejeitada das 19:30 é a última trabalhada');
  assert.equal(fmtParede(r.conclusaoMs), '2026-07-18 19:30:00');
});

test('nota sem data de conclusão não pode vencer', () => {
  // Sem instante não há como afirmar que foi a última.
  const r = ultimaNotaDaSessao({
    notasConcluidas: [
      { codigo: 'sem-data', conclusionDate: null },
      { codigo: 'com-data', conclusionDate: '2026-07-18T10:00:00' },
    ],
  });
  assert.equal(r.nota.codigo, 'com-data');
});

test('payload sem notas devolve null', () => {
  assert.equal(ultimaNotaDaSessao({}), null);
  assert.equal(ultimaNotaDaSessao(null), null);
  assert.equal(ultimaNotaDaSessao({ notasConcluidas: [] }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// A linha montada
// ─────────────────────────────────────────────────────────────────────────────

test('a linha traz as colunas da planilha, na semântica certa', () => {
  const j = janela('2026-07-18', '11:00', '20:00');
  const s = sessao('2026-07-18T11:00:00', FIM_18_07);
  const l = montarLinhaHe({
    equipe: 'EPMFL33', dia: '2026-07-18',
    cadastro: { cidade: 'MARECHAL FLORIANO', tipo_breve: 'A2', servico: 'PLT',
                regional: 'GUA', he_revisado: false },
    janela: j, sessao: s, he: calcularHe(j, s), valorHora: 376.28,
    ultima: ultimaNotaDaSessao({ notasConcluidas: [
      { tipoCode: 'PO', codigo: '104740451', status: 'executada',
        conclusionDate: '2026-07-18T20:14:00' }] }),
    qtd: 5,
  });
  assert.equal(l.equipe, 'EPMFL33');
  assert.equal(l.servico, 'PLT');
  assert.equal(l.cidade, 'MARECHAL FLORIANO');
  assert.equal(l.ultima_nota, 'PO - 104740451 - Executada');
  assert.equal(l.ultima_nota_em, '2026-07-18 20:14:00');
  assert.equal(l.qtd, 5);
  assert.equal(l.valor_hora, 376.28);
  assert.equal(l.inicio_escala, '2026-07-18 11:00:00');
  assert.equal(l.fim_escala, '2026-07-18 20:00:00');
  assert.equal(l.fim_sessao, '2026-07-18 20:43:06', 'segundos reconstruídos — ver FIM_18_07');
  assert.equal(l.total_min, 43);
  assert.equal(l.valor_total, 270.36);
  assert.equal(l.data, '2026-07-18');
  assert.equal(l.he_revisado, false, 'cadastro transcrito não passa por revisado');
});

test('equipe sem cadastro: linha existe, valor vazio', () => {
  // Omitir a linha esconderia hora extra; preencher com zero esconderia
  // cobrança. Regra 7 do CLAUDE.md.
  const j = janela('2026-07-18', '11:00', '20:00');
  const s = sessao('2026-07-18T11:00:00', FIM_18_07);
  const l = montarLinhaHe({
    equipe: 'XPTO99', dia: '2026-07-18', cadastro: null,
    janela: j, sessao: s, he: calcularHe(j, s), valorHora: null,
    ultima: null, qtd: 0,
  });
  assert.equal(l.total_min, 43, 'as horas continuam medidas');
  assert.equal(l.valor_total, null, 'o valor é vazio, não zero');
  assert.equal(l.tipo_breve, null);
  assert.equal(l.cidade, null);
});

test('QTD zero é preservado — não vira null nem some', () => {
  // Print de 09/09: há linhas com QTD 0 e 7h de prorrogação. O José confirmou
  // que é exceção real, não erro de leitura.
  const j = janela('2026-07-24', '08:00', '17:00');
  const s = sessao('2026-07-24T08:00:00', '2026-07-25T00:02:56');
  const l = montarLinhaHe({
    equipe: 'EBGPR64', dia: '2026-07-24',
    cadastro: { tipo_breve: 'A2', servico: 'STC', cidade: 'GUARAPARI' },
    janela: j, sessao: s, he: calcularHe(j, s), valorHora: 376.28,
    ultima: null, qtd: 0,
  });
  assert.equal(l.qtd, 0);
  assert.equal(l.total_min, 423);
});

test('fmtParede não desloca o dia', () => {
  // `toISOString()` a oeste de Greenwich mudaria a data — foi o bug do KPI de
  // escala em 30/08 (ver escalaQueries.diaISO).
  assert.equal(fmtParede(msParede('2026-01-01T00:00:00')), '2026-01-01 00:00:00');
  assert.equal(fmtParede(msParede('2026-12-31T23:59:59')), '2026-12-31 23:59:59');
  assert.equal(fmtParede(null), null);
  assert.equal(fmtParede(NaN), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rótulo de status — texto que vai numa planilha enviada à EDP
// ─────────────────────────────────────────────────────────────────────────────

test('concluida sai acentuada — o snapshot guarda sem acento', () => {
  assert.equal(
    rotuloUltimaNota({ tipoCode: 'MD', codigo: '045006418420', status: 'concluida' }),
    'MD - 045006418420 - Concluída');
});

test('status desconhecido é capitalizado, não traduzido por aproximação', () => {
  // A planilha tem "Interrompida", que não existe nos snapshots. Chutar uma
  // tradução seria pior que mostrar o termo cru.
  assert.equal(
    rotuloUltimaNota({ tipoCode: 'DD', codigo: '9', status: 'interrompida' }),
    'DD - 9 - Interrompida');
  assert.equal(
    rotuloUltimaNota({ tipoCode: 'XX', codigo: '1', status: 'xpto' }),
    'XX - 1 - Xpto');
});
