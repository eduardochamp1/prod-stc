/**
 * test/logoffSync.test.js
 *
 * Conserto do P1-47 (09/09/2026): o job das 03:00 perdia o logoff de todo
 * turno que sai depois dele.
 *
 * ⚠️ O QUE ESTÁ EM JOGO: sem `sessionEnd` a Medição HE não mede prorrogação, e
 * a linha cobra só a antecipação. No período medido a prorrogação é 344,73 h
 * contra 55,55 h de antecipação — a parte grande é justamente a que se perdia,
 * e atinge o turno NOTURNO, onde hora extra mais acontece. Toda noite.
 *
 * Medido antes do conserto: 113 sessões sem logoff em 16 dias, e a recuperação
 * manual achou o fim de **113 de 113** na EDP. O dado sempre existiu.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  VAZIO_EDP, chaveSessao, indexarFechadas, sincronizarDia, diaMenos,
} = require('../db/logoffSync');

const CRON = fs.readFileSync(path.join(__dirname, '..', 'services', 'cronService.js'), 'utf8');

const sessao = (nome, begin, end) =>
  ({ Team: { Name: nome, CompanyId: 'ENG' }, BeginTime: begin, EndTime: end });

// ─────────────────────────────────────────────────────────────────────────────
// Defeito 3: comparação de instante — string exata não casava
// ─────────────────────────────────────────────────────────────────────────────

test('a chave usa o INSTANTE, não o texto do início', () => {
  // '20:00:55', '20:00:55.000' e '20:00:55-03:00' são o MESMO instante e
  // nenhuma casa com a outra por string. O job antigo comparava
  // `sb1 === beginTime` e perdia a sessão por diferença de formato.
  const base = chaveSessao('EPGPR30', '2026-08-16T20:00:55');
  assert.equal(chaveSessao('EPGPR30', '2026-08-16T20:00:55.000'), base);
  assert.equal(chaveSessao('EPGPR30', '2026-08-16T20:00:55-03:00'), base);
});

test('a equipe entra normalizada — a EDP e o snapshot divergem em caixa', () => {
  const base = chaveSessao('EPGPR30', '2026-08-16T20:00:55');
  assert.equal(chaveSessao('  epgpr30 ', '2026-08-16T20:00:55'), base);
});

test('chave frouxa é rejeitada — casaria sessão errada', () => {
  // Gravar o fim de outra equipe é pior que não gravar nada.
  assert.equal(chaveSessao('', '2026-08-16T20:00:55'), null);
  assert.equal(chaveSessao(null, '2026-08-16T20:00:55'), null);
  assert.equal(chaveSessao('EPGPR30', 'lixo'), null);
  assert.equal(chaveSessao('EPGPR30', null), null);
});

test('equipes diferentes no mesmo instante não colidem', () => {
  assert.notEqual(
    chaveSessao('EPGPR30', '2026-08-16T20:00:00'),
    chaveSessao('EPGPR31', '2026-08-16T20:00:00'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Índice das fechadas
// ─────────────────────────────────────────────────────────────────────────────

test('indexa só sessão fechada, da Engelmig', () => {
  const mapa = indexarFechadas([
    sessao('A', '2026-08-16T08:00:00', '2026-08-16T17:30:00'),
    sessao('B', '2026-08-16T08:00:00', null),                       // aberta
    { Team: { Name: 'C', CompanyId: 'OUTRA' },
      BeginTime: '2026-08-16T08:00:00', EndTime: '2026-08-16T18:00:00' },
  ], 'ENG');
  assert.equal(mapa.size, 1);
  assert.equal(mapa.get(chaveSessao('A', '2026-08-16T08:00:00')), '2026-08-16T17:30:00');
});

test('a sentinela 0001-01-01 da EDP NÃO é logoff', () => {
  // Gravar isso como fim daria prorrogação negativa de dois mil anos.
  assert.equal(VAZIO_EDP, '0001-01-01T00:00:00');
  const mapa = indexarFechadas([sessao('A', '2026-08-16T08:00:00', VAZIO_EDP)], 'ENG');
  assert.equal(mapa.size, 0);
});

test('lista vazia ou suja não quebra', () => {
  assert.equal(indexarFechadas([], 'ENG').size, 0);
  assert.equal(indexarFechadas(null, 'ENG').size, 0);
  assert.equal(indexarFechadas([null, undefined, {}], 'ENG').size, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Orquestração — com pool e API falsos
// ─────────────────────────────────────────────────────────────────────────────

function poolFalso(abertas) {
  const gravou = [];
  return {
    gravou,
    query: async (sql, params) => {
      if (/WITH ultimo AS/.test(sql)) return { rows: abertas };
      if (/^\s*UPDATE public\.snapshots/.test(sql)) {
        gravou.push({ equipe: params[0], begin: params[1], fim: params[2] });
        return { rowCount: 1 };
      }
      throw new Error('query inesperada: ' + sql.slice(0, 40));
    },
  };
}

const aberta = (equipe, setor, begin) => ({ equipe, sector_id: setor, session_begin: begin });

test('grava o fim que a EDP tem', async () => {
  const pool = poolFalso([aberta('EPGPR30', 'DESG', '2026-08-16T20:00:55')]);
  const r = await sincronizarDia(pool,
    async () => [sessao('EPGPR30', '2026-08-16T20:00:55', '2026-08-17T05:12:00')],
    '2026-08-16', { companyId: 'ENG' });
  assert.equal(r.gravadas, 1);
  assert.equal(r.semPar, 0);
  assert.equal(pool.gravou[0].fim, '2026-08-17T05:12:00');
});

test('consulta SÓ os setores que têm sessão sem fim', async () => {
  // O job antigo varria os quatro setores sempre, gastando chamada à EDP onde
  // não havia nada a fazer.
  const pool = poolFalso([
    aberta('EPGPR30', 'DESG', '2026-08-16T20:00:00'),
    aberta('EPCIT33', 'DESC', '2026-08-16T17:00:00'),
  ]);
  const consultados = [];
  await sincronizarDia(pool, async (setor) => { consultados.push(setor); return []; },
    '2026-08-16', { companyId: 'ENG' });
  assert.deepEqual(consultados.sort(), ['DESC', 'DESG']);
});

test('setor com conta desativada é pulado, não é erro (P1-21)', async () => {
  const pool = poolFalso([aberta('ECMSJ81', 'DSSJ', '2026-08-16T10:00:00')]);
  const consultados = [];
  const r = await sincronizarDia(pool,
    async (s) => { consultados.push(s); return []; },
    '2026-08-16', { companyId: 'ENG', setorDesabilitado: s => s === 'DSSJ' });
  assert.deepEqual(consultados, [], 'não consulta setor desativado');
  assert.deepEqual(r.falhas, [], 'e não conta como falha');
});

test('falha num setor não impede os outros', async () => {
  const pool = poolFalso([
    aberta('EPGPR30', 'DESG', '2026-08-16T20:00:00'),
    aberta('EPCIT33', 'DESC', '2026-08-16T17:00:00'),
  ]);
  const r = await sincronizarDia(pool, async (setor) => {
    if (setor === 'DESG') throw new Error('token expirado');
    return [sessao('EPCIT33', '2026-08-16T17:00:00', '2026-08-17T01:00:00')];
  }, '2026-08-16', { companyId: 'ENG' });
  assert.equal(r.gravadas, 1, 'DESC gravou');
  assert.equal(r.falhas.length, 1);
  assert.equal(r.falhas[0].setor, 'DESG');
});

test('sem par na EDP é contado, não gravado', async () => {
  const pool = poolFalso([aberta('EPGPR30', 'DESG', '2026-08-16T20:00:00')]);
  const r = await sincronizarDia(pool, async () => [], '2026-08-16', { companyId: 'ENG' });
  assert.equal(r.gravadas, 0);
  assert.equal(r.semPar, 1);
  assert.deepEqual(pool.gravou, []);
});

test('dia sem sessão aberta não consulta a EDP', async () => {
  let chamou = false;
  const r = await sincronizarDia(poolFalso([]),
    async () => { chamou = true; return []; }, '2026-08-16', { companyId: 'ENG' });
  assert.equal(chamou, false);
  assert.equal(r.abertas, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Defeito 1: o job precisa olhar D-1 E D-2
// ─────────────────────────────────────────────────────────────────────────────

test('diaMenos atravessa virada de mês e de ano', () => {
  assert.equal(diaMenos('2026-09-01', 1), '2026-08-31');
  assert.equal(diaMenos('2026-09-01', 2), '2026-08-30');
  assert.equal(diaMenos('2026-01-01', 2), '2025-12-30');
  assert.equal(diaMenos('2026-03-01', 1), '2026-02-28');
});

test('o cron processa D-1 e D-2', () => {
  // Com D-2 o turno noturno tem ~24h pra fechar antes de perguntarmos, e o
  // horário do cron deixa de importar. Só D-1 perdia todo turno que sai depois
  // das 03:00 — foram 113 sessões em 16 dias.
  const i = CRON.indexOf('async function runSyncLogoffs');
  const bloco = CRON.slice(i, i + 2600);
  assert.match(bloco, /\[diaMenos\(hoje, 1\), diaMenos\(hoje, 2\)\]/);
  assert.match(bloco, /for \(const dia of dias\)/);
});

test('o cron delega pro módulo único, sem reimplementar', () => {
  // Antes eram duas implementações: a do script achou 113 fins que a do cron
  // não achava. Uma só, testada.
  const i = CRON.indexOf('async function runSyncLogoffs');
  const bloco = CRON.slice(i, i + 2600);
  assert.match(bloco, /require\('\.\.\/db\/logoffSync'\)/);
  assert.match(bloco, /sincronizarDia\(pool, getSessionsByDate, dia/);
  // A janela de 20 linhas era o defeito 2 — não pode voltar.
  assert.doesNotMatch(bloco, /limit\(20\)/);
  assert.doesNotMatch(bloco, /sb1 === beginTime/);
});

test('o cron respeita conta desativada e mantém o contrato de retorno', () => {
  const i = CRON.indexOf('async function runSyncLogoffs');
  const bloco = CRON.slice(i, i + 2600);
  assert.match(bloco, /setorDesabilitado: isSectorDisabled/);
  // `date` e `updated` são lidos por chamador antigo.
  assert.match(bloco, /return \{ date: dias\[0\], dias, updated: totalUpdated/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Defeito da dessincronia: coluna E jsonb
// ─────────────────────────────────────────────────────────────────────────────

test('grava a COLUNA e o JSONB juntos', () => {
  // O job antigo gravava só `data`, e foi essa dessincronia que fez a Medição
  // HE ler o campo errado e tratar 164 sessões como abertas.
  const SYNC = fs.readFileSync(path.join(__dirname, '..', 'db', 'logoffSync.js'), 'utf8');
  const i = SYNC.indexOf('async function gravarFim');
  const bloco = SYNC.slice(i, i + 900);
  assert.match(bloco, /SET session_end = \$3/);
  assert.match(bloco, /jsonb_set\(COALESCE\(data, '\{\}'::jsonb\), '\{sessionEnd\}'/);
  // Idempotência: só toca linha sem fim, e nunca sobrescreve.
  assert.match(bloco, /COALESCE\(session_end, data->>'sessionEnd', data->>'session_end'\) IS NULL/);
});

// ─────────────────────────────────────────────────────────────────────────────
// O script não pode confundir "hoje em curso" com falha de captura
// ─────────────────────────────────────────────────────────────────────────────

test('o script marca e separa as sessões de HOJE', () => {
  // 09/09/2026: eu mandei conferir o conserto com um intervalo que incluía
  // hoje. Apareceram 35 sessões abertas — todas de equipes em campo naquele
  // momento — e o número pareceu falha do conserto. Era o esperado: o dia não
  // acabou. Juízo sobre captura só vale em dia fechado.
  const S = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'recuperar-logoffs.js'), 'utf8');
  assert.match(S, /HOJE SEMPRE TEM SESSÃO ABERTA/);
  assert.match(S, /const HOJE = dateBRT\(\)/);
  assert.match(S, /p\.dia >= HOJE/);
  assert.match(S, /esperado, não é falha de captura/);
  // Se TUDO que sobrou é de hoje, o script conclui limpo em vez de alarmar.
  assert.match(S, /deHoje === total/);
  assert.match(S, /Fora de hoje, nenhuma sessão sem logoff/);
});
