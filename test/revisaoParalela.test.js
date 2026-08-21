/**
 * test/revisaoParalela.test.js
 *
 * Cobre as correções da revisão paralela de 20/08/2026:
 *   P1-27  histórico multi-dia: um Set por bucket + dedup por UUID
 *   P1-34  _reconstruirDeslogada aplica "rejeitada > concluída"
 *   P1-28  checkpoint usa TimeStamp (UTC) e não RegisteredAt2 (BR)
 *   P1-32  breaker deixa de ser fail-open em mensagem desconhecida
 *   P1-30  getTeams devolve o report DAQUELA chamada via `out`
 *   P2-32  todo tipo de nota tem endpoint candidato (VL/SM não tinham)
 */

const test = require('node:test');
const assert = require('node:assert');

// ─────────────────────────────────────────────────────────────────────────────
// P1-27 — Set por bucket + dedup por UUID no range do histórico
// ─────────────────────────────────────────────────────────────────────────────
const { _acumularNotasRange } = require('../db/queries');

test('P1-27: nota concluída E rejeitada aparece nos DOIS buckets', () => {
  // O bug: com um Set compartilhado, a nota entrava só no bucket que fosse
  // visitado primeiro — e a ordem dependia de captured_at.
  const rows = [
    { team_name: 'ECT01', data: {
        notasConcluidas: [{ id: 'u1', codigo: '030001' }],
        notasRejeitadas: [{ id: 'u1', codigo: '030001' }],
    } },
  ];
  const acc = _acumularNotasRange(rows).ECT01;
  assert.equal(acc.conc.length, 1, 'deve estar em concluídas');
  assert.equal(acc.rej.length, 1, 'deve estar em rejeitadas');
});

test('P1-27: ordem dos snapshots não muda o resultado', () => {
  const snapA = { team_name: 'ECT01', data: {
    notasConcluidas: [{ id: 'u1' }], notasRejeitadas: [] } };
  const snapB = { team_name: 'ECT01', data: {
    notasConcluidas: [], notasRejeitadas: [{ id: 'u1' }] } };

  const ab = _acumularNotasRange([snapA, snapB]).ECT01;
  const ba = _acumularNotasRange([snapB, snapA]).ECT01;

  assert.equal(ab.conc.length, 1);
  assert.equal(ab.rej.length, 1);
  assert.equal(ba.conc.length, 1);
  assert.equal(ba.rej.length, 1);
});

test('P1-27: dedup entre snapshots continua valendo (1 nota = 1x por bucket)', () => {
  const rows = [
    { team_name: 'ECT01', data: { notasConcluidas: [{ id: 'u1' }, { id: 'u2' }] } },
    { team_name: 'ECT01', data: { notasConcluidas: [{ id: 'u1' }] } },
    { team_name: 'ECT01', data: { notasConcluidas: [{ id: 'u2' }, { id: 'u3' }] } },
  ];
  const acc = _acumularNotasRange(rows).ECT01;
  assert.equal(acc.conc.length, 3);
});

test('P1-27: dedup é por UUID — mesmo código com ids diferentes conta 2x', () => {
  // O portal WPA exibe linhas duplicadas; a regra da casa é contar por UUID.
  const rows = [
    { team_name: 'ECT01', data: { notasConcluidas: [
      { id: 'u1', codigo: '030001' },
      { id: 'u2', codigo: '030001' },
    ] } },
  ];
  const acc = _acumularNotasRange(rows).ECT01;
  assert.equal(acc.conc.length, 2);
});

test('P1-27: nota sem id cai no fallback por código', () => {
  const rows = [
    { team_name: 'ECT01', data: { notasConcluidas: [{ codigo: '030001' }] } },
    { team_name: 'ECT01', data: { notasConcluidas: [{ codigo: '030001' }] } },
  ];
  const acc = _acumularNotasRange(rows).ECT01;
  assert.equal(acc.conc.length, 1);
});

test('P1-27: nota sem id e sem código é ignorada', () => {
  const acc = _acumularNotasRange(
    [{ team_name: 'ECT01', data: { notasConcluidas: [{}, { id: 'u1' }] } }]).ECT01;
  assert.equal(acc.conc.length, 1);
});

test('P1-27: equipes não se misturam', () => {
  const rows = [
    { team_name: 'ECT01', data: { notasConcluidas: [{ id: 'u1' }] } },
    { team_name: 'ECT02', data: { notasConcluidas: [{ id: 'u1' }] } },
  ];
  const r = _acumularNotasRange(rows);
  assert.equal(r.ECT01.conc.length, 1);
  assert.equal(r.ECT02.conc.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-34 — equipe deslogada respeita "rejeitada > concluída"
// ─────────────────────────────────────────────────────────────────────────────
const { _reconstruirDeslogada } = require('../db/queries');

test('P1-34: nota concluída E rejeitada não conta como executada na deslogada', () => {
  const unido = {
    teamName: 'ECT01',
    regional: 'GUA',
    notasConcluidas: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
    notasRejeitadas: [{ id: 'u3' }],
  };
  const ultimo = { notasExecutadas: [], notasBaixadas: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] };
  const t = _reconstruirDeslogada(unido, ultimo, {}, '2026-08-19');

  assert.equal(t.metrics.executadas, 2, 'u3 foi rejeitada → não é produção');
  assert.equal(t.metrics.rejeitadas, 1);
  // A lista crua continua completa — o front aplica o mesmo filtro nos chips.
  assert.equal(t.notasConcluidas.length, 3);
});

test('P1-34: sem rejeição, a contagem não muda', () => {
  const unido = {
    teamName: 'ECT01',
    notasConcluidas: [{ id: 'u1' }, { id: 'u2' }],
    notasRejeitadas: [],
  };
  const t = _reconstruirDeslogada(unido, { notasBaixadas: [] }, {}, '2026-08-19');
  assert.equal(t.metrics.executadas, 2);
  assert.equal(t.metrics.rejeitadas, 0);
});

test('P1-34: rejeição de nota que NÃO foi concluída não subtrai produção', () => {
  const unido = {
    teamName: 'ECT01',
    notasConcluidas: [{ id: 'u1' }],
    notasRejeitadas: [{ id: 'u9' }],
  };
  const t = _reconstruirDeslogada(unido, { notasBaixadas: [] }, {}, '2026-08-19');
  assert.equal(t.metrics.executadas, 1);
  assert.equal(t.metrics.rejeitadas, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-28 — checkpoints: UTC primeiro, BR convertido
// ─────────────────────────────────────────────────────────────────────────────
const { processarNota, fixCachedPayloadTz } = require('../services/notaProcessor');

test('P1-28: timestamp do checkpoint vem do TimeStamp UTC, não do RegisteredAt2', () => {
  const nota = { Checkpoints: [{
    Id: 'c1', Event: 0,
    RegisteredAt2: '15/08/2026 11:23:45',
    TimeStamp: '2026-08-15T14:23:45',
  }] };
  const out = processarNota(nota);
  assert.equal(out.checkpoints[0].timestamp, '2026-08-15T14:23:45Z');
  assert.ok(!Number.isNaN(new Date(out.checkpoints[0].timestamp).getTime()));
});

test('P1-28: sem TimeStamp, o RegisteredAt2 BR é convertido pra ISO parseável', () => {
  // Era aqui que nascia o "Invalid Date": new Date("15/08/2026 11:23:45") = NaN.
  const nota = { Checkpoints: [{ Id: 'c1', RegisteredAt2: '15/08/2026 11:23:45' }] };
  const out = processarNota(nota);
  assert.equal(out.checkpoints[0].timestamp, '2026-08-15T11:23:45-03:00');
  assert.ok(!Number.isNaN(new Date(out.checkpoints[0].timestamp).getTime()));
});

test('P1-28: ordenação cronológica funciona no dia 15 (antes era no-op)', () => {
  const nota = { Checkpoints: [
    { Id: 'c2', TimeStamp: '2026-08-15T17:00:00', RegisteredAt2: '15/08/2026 14:00:00' },
    { Id: 'c1', TimeStamp: '2026-08-15T13:00:00', RegisteredAt2: '15/08/2026 10:00:00' },
  ] };
  const out = processarNota(nota);
  assert.deepEqual(out.checkpoints.map(c => c.id), ['c1', 'c2']);
});

test('P1-28: cache antigo com timestamp BR é reparado na leitura', () => {
  const payload = { checkpoints: [{ id: 'c1', timestamp: '15/08/2026 11:23:45' }] };
  const fixed = fixCachedPayloadTz(payload);
  assert.equal(fixed.checkpoints[0].timestamp, '2026-08-15T11:23:45-03:00');
});

test('P1-28: cache já em ISO não é alterado duas vezes', () => {
  const payload = { checkpoints: [{ id: 'c1', timestamp: '2026-08-15T14:23:45Z' }] };
  const fixed = fixCachedPayloadTz(payload);
  assert.equal(fixed.checkpoints[0].timestamp, '2026-08-15T14:23:45Z');
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-32 — breaker não é mais fail-open
// ─────────────────────────────────────────────────────────────────────────────
const wpa = require('../services/wpaService');

test('P1-32: mensagem desconhecida NÃO abre na 1ª falha (pode ser soluço da API)', () => {
  wpa._clearBreaker('testacc32a');
  const r = wpa._openBreaker('testacc32a', 'Erro inesperado da EDP 500');
  assert.equal(r, null);
  assert.equal(wpa._breakerRemaining('testacc32a'), 0);
});

test('P1-32: mensagem desconhecida ABRE na 2ª falha consecutiva', () => {
  wpa._clearBreaker('testacc32b');
  wpa._openBreaker('testacc32b', 'Senha incorreta');          // texto que nossos regexes não pegam
  const r = wpa._openBreaker('testacc32b', 'Senha incorreta');
  assert.ok(r, 'deveria abrir na 2ª');
  assert.equal(r.kind, 'unknown_error');
  assert.ok(wpa._breakerRemaining('testacc32b') > 0);
  wpa._clearBreaker('testacc32b');
});

test('P1-32: login bem-sucedido zera o contador de falhas desconhecidas', () => {
  wpa._clearBreaker('testacc32c');
  wpa._openBreaker('testacc32c', 'Too many attempts');
  wpa._clearBreaker('testacc32c');                              // sucesso
  const r = wpa._openBreaker('testacc32c', 'Too many attempts'); // volta a ser a 1ª
  assert.equal(r, null);
  wpa._clearBreaker('testacc32c');
});

test('P1-32: credencial inválida continua abrindo na 1ª (comportamento do P1-20)', () => {
  wpa._clearBreaker('testacc32d');
  const r = wpa._openBreaker('testacc32d', 'Usuário ou senha inválidos');
  assert.ok(r);
  assert.equal(r.kind, 'invalid_credential');
  wpa._clearBreaker('testacc32d');
});

test('P1-32: cooldown de mensagem desconhecida é CURTO (menor que o de credencial)', () => {
  const now = Date.now();
  wpa._clearBreaker('testacc32e');
  wpa._openBreaker('testacc32e', 'xpto', now);
  const desconhecido = wpa._openBreaker('testacc32e', 'xpto', now);
  wpa._clearBreaker('testacc32f');
  const invalido = wpa._openBreaker('testacc32f', 'senha inválida', now);
  assert.ok(desconhecido.until < invalido.until,
    'desconhecido deve ter cooldown mais curto que credencial inválida');
  wpa._clearBreaker('testacc32e');
  wpa._clearBreaker('testacc32f');
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-30 — report por chamada
// ─────────────────────────────────────────────────────────────────────────────
test('P1-30: getTeams escreve o report DAQUELA chamada em `out`', async () => {
  // Roda o caminho real (DATA_MODE=wpa) com TODAS as contas desativadas pelo
  // kill-switch: assim o loop por setor executa e classifica tudo como
  // `skipped`, sem tocar a rede. Recarrega os módulos porque tanto o MODE
  // quanto `_disabledAccounts` são lidos no load.
  const envAntes = {
    DATA_MODE: process.env.DATA_MODE,
    WPA_ACCOUNTS_DISABLED: process.env.WPA_ACCOUNTS_DISABLED,
  };
  process.env.DATA_MODE = 'wpa';
  process.env.WPA_ACCOUNTS_DISABLED = 'es,sp,sp2';

  const paths = [
    require.resolve('../services/dataService'),
    require.resolve('../services/wpaService'),
  ];
  const cacheAntes = paths.map(p => require.cache[p]);
  paths.forEach(p => delete require.cache[p]);

  try {
    const ds = require('../services/dataService');
    const out = {};
    const teams = await ds.getTeams({ regionals: ['GUA', 'CAC', 'SJC'] }, out);

    assert.ok(out.report, 'out.report deve ser preenchido');
    assert.ok(Array.isArray(out.report.ok));
    assert.ok(Array.isArray(out.report.failed));
    assert.ok(out.report.skipped.length > 0, 'todos os setores deviam estar skipped');
    assert.equal(out.report.ok.length, 0);
    assert.deepEqual(teams, [], 'sem conta ativa não há equipe');

    // E o report de `out` é o mesmo daquela chamada, não um global qualquer.
    const out2 = {};
    await ds.getTeams({ regionals: ['GUA'] }, out2);
    assert.ok(out2.report.skipped.length < out.report.skipped.length,
      'escopo menor → menos setores no report da SUA chamada');
  } finally {
    paths.forEach((p, i) => { if (cacheAntes[i]) require.cache[p] = cacheAntes[i]; });
    for (const [k, v] of Object.entries(envAntes)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-32 — tipos de nota sem candidato de endpoint nunca eram tentados
// ─────────────────────────────────────────────────────────────────────────────
const rejSvc = require('../services/rejectionService');

test('P2-32: VL e SM agora têm candidatos de endpoint', () => {
  // A medição de 21/08 achou VL com 1278 rejeições e 100% sem RejectedAt: o tipo
  // não estava em CANDIDATE_PATHS, então caía no ramo que devolve
  // endpoint_missing SEM fazer nenhuma chamada.
  assert.ok(Array.isArray(rejSvc.CANDIDATE_PATHS.VL), 'VL precisa de candidatos');
  assert.ok(Array.isArray(rejSvc.CANDIDATE_PATHS.SM), 'SM precisa de candidatos');
  // E os FALLBACK_PATHS (que resolveram DL/LE/RL) têm de estar na frente.
  assert.ok(rejSvc.CANDIDATE_PATHS.VL.includes('sfrl'));
  assert.ok(rejSvc.CANDIDATE_PATHS.VL.includes('md'));
});

test('P2-32: todo tipo visto em produção tem KNOWN_PATHS ou CANDIDATE_PATHS', () => {
  // Guarda-corpo: tipo novo aparecendo em produção sem entrada aqui volta a
  // gravar rejeição sem data nem motivo, silenciosamente.
  const vistos = ['MD', 'LN', 'SF', 'DL', 'LE', 'RL', 'VL', 'SM'];
  const semCobertura = vistos.filter(
    t => !rejSvc.KNOWN_PATHS[t] && !rejSvc.CANDIDATE_PATHS[t]);
  assert.deepEqual(semCobertura, [], `tipos sem endpoint mapeado: ${semCobertura}`);
});

test('P2-32: cache negativo começa vazio e é resetável', () => {
  rejSvc._resetNoPathCache();
  assert.deepEqual(rejSvc.getNoPathTipos(), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Deslocamento — as 3 rotas têm de compartilhar UM cálculo (21/08/2026)
// ─────────────────────────────────────────────────────────────────────────────
const desloc = require('../db/deslocamentosQueries');

test('desloc: limit string da querystring e número interno geram a MESMA chave', () => {
  // O front manda limit=20000 (string) em /lista; rankingEquipes e tendenciaDiaria
  // chamam com limit: 20000 (número). Antes o _key fazia `o.limit || null`, então
  // JSON.stringify gerava chaves diferentes e o single-flight nunca colidia — o
  // pipeline caro (varredura de note_details + até 20k consultas OSRM) rodava 3x.
  const daRota    = desloc._key('list', '2026-08-01', '2026-08-20', { limit: '20000', regionais: ['GUA'] });
  const interno   = desloc._key('list', '2026-08-01', '2026-08-20', { limit: 20000,   regionais: ['GUA'] });
  assert.equal(daRota, interno);
});

test('desloc: chave ignora ordem das regionais e das equipes', () => {
  const a = desloc._key('list', '2026-08-01', '2026-08-20', { regionais: ['SJC', 'GUA'], teams: ['B', 'A'] });
  const b = desloc._key('list', '2026-08-01', '2026-08-20', { regionais: ['GUA', 'SJC'], teams: ['A', 'B'] });
  assert.equal(a, b);
});

test('desloc: filtros diferentes NÃO compartilham chave', () => {
  const base = { limit: 20000, regionais: ['GUA'] };
  const k = o => desloc._key('list', '2026-08-01', '2026-08-20', { ...base, ...o });
  assert.notEqual(k({}), k({ acimaPct: 50 }));
  assert.notEqual(k({}), k({ somenteLentos: true }));
  assert.notEqual(k({}), k({ tipo: 'MD' }));
  assert.notEqual(k({}), k({ regionais: ['SJC'] }));
});

test('desloc: limit vazio ou ausente vira null (não NaN)', () => {
  const a = desloc._key('list', '2026-08-01', '2026-08-20', {});
  const b = desloc._key('list', '2026-08-01', '2026-08-20', { limit: '' });
  assert.equal(a, b);
  assert.ok(!a.includes('null,"limit":NaN') && !a.includes('NaN'));
});
