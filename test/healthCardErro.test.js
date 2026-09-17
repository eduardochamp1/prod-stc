/**
 * test/healthCardErro.test.js
 *
 * Aba Admin → "SAÚDE DO SISTEMA": falha de leitura tem que aparecer como ERRO,
 * nunca como `0`.
 *
 * Bug reportado em 17/09/2026 — o card exibia `0/138 (GUA 0 · CAC 0)` e
 * `último snapshot: sem dados` numa quinta-feira às 16h20, com teams_current
 * cheia (117 linhas, 4 min de idade) e os 4 setores coletados sem falha
 * (snapshot_last_ok: teams 146, ghosts 0, sectors_failed []).
 *
 * O backend responde `teams_logged_today: { error }` quando a query estoura, e
 * o `logged.total || 0` do front transformava a exceção num zero legítimo. Um
 * zero falso é pior que um traço honesto: foi ele que escondeu por 4 meses o
 * `data->>date` sem aspas do getTeamsCurrent (ver teamsCurrentJsonbPath.test.js).
 * Mesma regra do P1-39 no card de regional.
 *
 * Não há harness de frontend (risco H11), mas `renderHealth` é PURA — só lê `h`
 * e monta string, sem tocar no DOM. Então aqui ela é extraída do index.html e
 * executada de verdade, não só inspecionada como texto.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Extrai o corpo de uma função do index.html casando as chaves. */
function extrairFuncao(nome) {
  const marca = `function ${nome}(`;
  const ini   = SRC.indexOf(marca);
  assert.ok(ini > -1, `não achei ${marca} no index.html`);

  const abre = SRC.indexOf('{', ini);
  let nivel = 0;
  for (let i = abre; i < SRC.length; i++) {
    if (SRC[i] === '{') nivel++;
    else if (SRC[i] === '}') {
      nivel--;
      if (nivel === 0) return SRC.slice(ini, i + 1);
    }
  }
  throw new Error(`chaves não fecharam em ${nome}`);
}

// eslint-disable-next-line no-new-func
const renderHealth = new Function(`${extrairFuncao('renderHealth')}; return renderHealth;`)();

/** Payload de /admin/health no caminho feliz. */
function payloadOk(over = {}) {
  return {
    ok: true,
    whitelist: { total: 138, gua: 44, cac: 35, sjc: 59 },
    teams_logged_today:  { total: 117, byRegional: { GUA: 44, CAC: 35, SJC: 38 } },
    teams_missing_today: { total: 0, lista: [] },
    last_snapshot:       { ts: new Date().toISOString(), ageMinutes: 4 },
    snapshot_last_ok:    { ts: new Date().toISOString() },
    snapshot_error:      null,
    snapshot_stale_min:  4,
    subcat_error:        null,
    token:               { expiresAt: new Date(Date.now() + 2873 * 60000).toISOString() },
    metas_configured:    { gua: true, cac: true },
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// O defeito de 17/09/2026: exceção virava zero
// ─────────────────────────────────────────────────────────────────────────────

test('query falhou → card mostra o ERRO, não `0/138`', () => {
  const html = renderHealth(payloadOk({
    teams_logged_today: { error: 'column "date" does not exist' },
    last_snapshot:      null,
  }));

  assert.ok(/erro:/i.test(html), 'esperava o texto do erro no card');
  assert.ok(
    !html.includes('0/138'),
    'exceção de query NÃO pode ser renderizada como 0/138 — foi o bug de 17/09/2026'
  );
});

test('query falhou → a mensagem real do Postgres chega na tela', () => {
  const html = renderHealth(payloadOk({
    teams_logged_today: { error: 'column "date" does not exist' },
    last_snapshot:      null,
  }));

  assert.ok(
    html.includes('column "date" does not exist'.slice(0, 40)),
    'a causa tem que ser legível sem abrir o DevTools'
  );
});

test('campo ausente (backend antigo) → traço, não zero', () => {
  const html = renderHealth(payloadOk({ teams_logged_today: null, last_snapshot: null }));
  assert.ok(html.includes('—'), 'sem dado é traço');
  assert.ok(!html.includes('0/138'), 'ausência não é zero');
});

// ─────────────────────────────────────────────────────────────────────────────
// Zero LEGÍTIMO continua sendo zero — o fix não pode mascarar ausência real
// ─────────────────────────────────────────────────────────────────────────────

test('ninguém logou de verdade → 0/138 continua aparecendo', () => {
  const html = renderHealth(payloadOk({
    teams_logged_today: { total: 0, byRegional: { GUA: 0, CAC: 0, SJC: 0 } },
  }));

  assert.ok(html.includes('0/138'), 'zero real precisa continuar visível');
  assert.ok(!/erro:/i.test(html), 'zero real não é erro');
});

test('caminho feliz → contagem e detalhamento por regional', () => {
  const html = renderHealth(payloadOk());
  assert.ok(html.includes('117/138'));
  assert.ok(html.includes('GUA 44'));
  assert.ok(html.includes('CAC 35'));
});

// ─────────────────────────────────────────────────────────────────────────────
// "Último snapshot": cai no snapshot_last_ok quando a leitura direta falha
// ─────────────────────────────────────────────────────────────────────────────

test('sem last_snapshot mas com ciclo saudável → idade do ciclo, não "sem dados"', () => {
  const html = renderHealth(payloadOk({ last_snapshot: null, snapshot_stale_min: 4 }));

  assert.ok(html.includes('há 4 min'), 'a idade vem do snapshot_last_ok (P1-3)');
  assert.ok(
    !html.includes('sem dados'),
    'com o ciclo saudável no payload, "sem dados" é mentira — era o 2º sintoma de 17/09/2026'
  );
});

test('erro no ciclo de coleta fica visível no card de snapshot', () => {
  const html = renderHealth(payloadOk({
    snapshot_error: { ts: new Date().toISOString(), message: 'DESG falhou' },
  }));
  assert.ok(html.includes('erro no ciclo'));
});

test('ciclo realmente sem registro → segue "sem dados"', () => {
  const html = renderHealth(payloadOk({
    last_snapshot: null, snapshot_stale_min: null, snapshot_last_ok: null,
  }));
  assert.ok(html.includes('sem dados'), 'ausência real continua reportada');
});
