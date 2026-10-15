/**
 * test/alertasFront.test.js
 *
 * Balão de AVISOS (lado esquerdo) do alerta de baixa produtividade (T7).
 * O repo não tem jsdom, então:
 *   - o script dos avisos é EXTRAÍDO do index.html e EXECUTADO num `vm` com um
 *     DOM falso — isso exercita render, escape e contador de verdade;
 *   - o que não dá pra executar (posição do markup, ganchos do init, CSS) é
 *     conferido como texto, no estilo de test/fabAcoesRapidas.test.js.
 * Não prova que o balão abre no navegador — isso se confere à mão.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ = path.join(__dirname, '..');
// Normaliza CRLF → LF: num clone Windows com core.autocrlf=true (esta máquina, onde
// roda o hook de pre-push) o checkout grava CRLF, e os testes de fonte que procuram
// "\n" ficavam vermelhos sem o código ter mudado (achado em 14/10/2026).
const ler = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8').replace(/\r\n/g, '\n');
const HTML = ler('public', 'index.html');
const CSS = ler('public', 'css', 'app.css');

const INI = HTML.indexOf('/* ── AVISOS (balão esquerdo)');
const FIM = HTML.indexOf('</script>', INI);
const SCRIPT_AVISOS = HTML.slice(INI, FIM);
const BASE = 'WPA Monitor — Engelmig Energia';

/** Executa o script dos avisos com um DOM falso; devolve o mundo para inspeção. */
function mundo({ fetchImpl, siglas = null } = {}) {
  const els = {};
  const el = (id, extra = {}) => (els[id] = { id, hidden: false, textContent: '', innerHTML: '', classList: { add() {}, remove() {} },
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, focus() { this.focado = true; }, ...extra });
  for (const id of ['fab-avisos', 'fab-avisos-painel', 'fab-avisos-toggle', 'fab-avisos-icone',
    'fab-avisos-contador', 'fab-avisos-lista', 'avisos-supervisor-select']) el(id);
  els['fab-avisos-toggle'].attrs['aria-expanded'] = 'false';

  const ctx = {
    document: { title: BASE, getElementById: (id) => els[id] || null },
    API: '/api',
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ ativo: false, alertas: [] }) })),
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    _supSiglasDoSelect: () => siglas,
    _supPopularSelect: async () => {},
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => fn(),
    console: { warn() {}, log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT_AVISOS, ctx);
  return { ctx, els };
}

const alerta = (o = {}) => ({
  equipe: 'ECGPR53', regional: 'GUA', supervisor: 'JOAO SILVA', executadas: 2, rejeitadas: 1, limite: 4,
  meioTurnoEm: '2026-10-14T15:30:00.000Z', disparadoEm: '2026-10-14T15:31:00.000Z',
  turno: { inicio: '08:00', fim: '17:00' }, ...o,
});
const resposta = (ativo, alertas) => async () => ({ ok: true, json: async () => ({ ativo, alertas }) });

describe('texto de uma linha de aviso', () => {
  test('plural, rejeitadas, hora do meio do turno em BRT e turno', () => {
    const { ctx } = mundo();
    assert.equal(ctx.avisosTexto(alerta()),
      '2 executadas (+1 rejeitada) · meio do turno 12:30 · turno 08:00–17:00');
  });
  test('singular; rejeitadas omitidas quando 0; plural das rejeitadas', () => {
    const { ctx } = mundo();
    assert.match(ctx.avisosTexto(alerta({ executadas: 1, rejeitadas: 0 })), /^1 executada · /);
    assert.doesNotMatch(ctx.avisosTexto(alerta({ rejeitadas: 0 })), /rejeitada/);
    assert.match(ctx.avisosTexto(alerta({ rejeitadas: 3 })), /\(\+3 rejeitadas\)/);
  });
  test('zero executadas aparece (é o caso mais importante)', () => {
    const { ctx } = mundo();
    assert.match(ctx.avisosTexto(alerta({ executadas: 0 })), /^0 executadas/);
  });
  test('sem meio do turno ou sem turno, omite o trecho em vez de escrever "undefined"', () => {
    const { ctx } = mundo();
    const t = ctx.avisosTexto(alerta({ meioTurnoEm: null, turno: { inicio: null, fim: null } }));
    assert.equal(t, '2 executadas (+1 rejeitada)');
    assert.doesNotMatch(t, /undefined|null|NaN/);
  });
  test('a hora é a de BRT mesmo que o navegador esteja em outro fuso', () => {
    const { ctx } = mundo();
    assert.equal(ctx.avisosHoraBRT('2026-10-14T02:30:00Z'), '23:30');
  });
});

describe('render', () => {
  test('desligado: o balão NEM APARECE, sem contador, título intacto', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(false, []) });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos'].hidden, true);
    assert.equal(els['fab-avisos-contador'].hidden, true);
    assert.equal(ctx.document.title, BASE);
  });
  test('ativo e vazio: balão visível, sem contador, "Nenhum alerta agora."', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, []) });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos'].hidden, false);
    assert.equal(els['fab-avisos-contador'].hidden, true);
    assert.match(els['fab-avisos-lista'].innerHTML, /Nenhum alerta agora\./);
    assert.equal(ctx.document.title, BASE);
  });
  test('com alertas: contador e título "(N) ..." e uma linha por equipe', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta(), alerta({ equipe: 'ETGPR16', supervisor: null })]) });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos-contador'].hidden, false);
    assert.equal(els['fab-avisos-contador'].textContent, '2');
    assert.equal(ctx.document.title, `(2) ${BASE}`);
    const html = els['fab-avisos-lista'].innerHTML;
    assert.match(html, /ECGPR53/);
    assert.match(html, /ETGPR16/);
    assert.match(html, /Sup\. JOAO SILVA/);
    assert.equal((html.match(/Sup\./g) || []).length, 1, 'sem supervisor não escreve "Sup."');
  });
  test('mais de 99 alertas → "99+"', async () => {
    const muitos = Array.from({ length: 120 }, (_, i) => alerta({ equipe: `ECGPR${i}` }));
    const { ctx, els } = mundo({ fetchImpl: resposta(true, muitos) });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos-contador'].textContent, '99+');
    assert.equal(ctx.document.title, `(120) ${BASE}`);
  });
  test('o filtro de supervisor reduz a lista E o contador E o título', async () => {
    const { ctx, els } = mundo({
      fetchImpl: resposta(true, [alerta(), alerta({ equipe: 'ETGPR16' })]),
      siglas: new Set(['ECGPR53']),
    });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos-contador'].textContent, '1');
    assert.equal(ctx.document.title, `(1) ${BASE}`);
    assert.doesNotMatch(els['fab-avisos-lista'].innerHTML, /ETGPR16/);
  });
  test('TEXTO VINDO DO BANCO É ESCAPADO (equipe, regional, supervisor)', async () => {
    const ruim = '<img src=x onerror=alert(1)>';
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta({ equipe: ruim, regional: ruim, supervisor: ruim })]) });
    await ctx.carregarAvisos();
    const html = els['fab-avisos-lista'].innerHTML;
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });
});

describe('falha e recarga', () => {
  test('falha de rede: "Avisos indisponíveis.", sem derrubar nada', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta()]) });
    await ctx.carregarAvisos();                      // 1ª vez OK
    ctx.fetch = async () => { throw new Error('rede'); };
    await ctx.carregarAvisos();                      // 2ª falha
    assert.match(els['fab-avisos-lista'].innerHTML, /Avisos indisponíveis\./);
  });
  test('HTTP != 2xx também vira "indisponível"', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta()]) });
    await ctx.carregarAvisos();
    ctx.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await ctx.carregarAvisos();
    assert.match(els['fab-avisos-lista'].innerHTML, /indisponíveis/);
  });
  test('falha na 1ª carga com alerta desligado mantém o balão ESCONDIDO', async () => {
    const { ctx, els } = mundo({ fetchImpl: async () => { throw new Error('rede'); } });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos'].hidden, true);
  });
  test('chama o endpoint certo e tolera corpo sem alertas', async () => {
    let url;
    const { ctx, els } = mundo({ fetchImpl: async (u) => { url = u; return { ok: true, json: async () => ({ ativo: true }) }; } });
    await ctx.carregarAvisos();
    assert.equal(url, '/api/alertas/produtividade');
    assert.match(els['fab-avisos-lista'].innerHTML, /Nenhum alerta agora/);
  });
});

describe('abrir / fechar', () => {
  test('abrir: aria-expanded, glifo ✕, painel visível e recarrega os avisos', async () => {
    let chamadas = 0;
    const { ctx, els } = mundo({ fetchImpl: async () => { chamadas++; return { ok: true, json: async () => ({ ativo: true, alertas: [] }) }; } });
    ctx.avisosToggle();
    assert.equal(els['fab-avisos-toggle'].attrs['aria-expanded'], 'true');
    assert.equal(els['fab-avisos-icone'].textContent, '✕');
    assert.equal(els['fab-avisos-painel'].hidden, false);
    assert.equal(chamadas, 1);
  });
  test('catálogo de supervisores FALHANDO ao abrir não vira promise rejeitada solta', async () => {
    const soltas = [];
    const ouvinte = (e) => soltas.push(e);
    process.on('unhandledRejection', ouvinte);
    try {
      const { ctx } = mundo();
      ctx._supPopularSelect = () => Promise.reject(new Error('catálogo fora'));
      ctx.avisosToggle();
      await new Promise(r => setTimeout(r, 20));
      // throw SÍNCRONO também não pode escapar
      const m2 = mundo();
      m2.ctx._supPopularSelect = () => { throw new Error('síncrono'); };
      assert.doesNotThrow(() => m2.ctx.avisosToggle());
      await new Promise(r => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', ouvinte);
    }
    assert.deepEqual(soltas, []);
  });
  test('fechar: volta o 🔔 e esconde o painel', () => {
    const { ctx, els } = mundo();
    ctx.avisosToggle();
    ctx.avisosToggle();
    assert.equal(els['fab-avisos-toggle'].attrs['aria-expanded'], 'false');
    assert.equal(els['fab-avisos-icone'].textContent, '🔔');
    assert.equal(els['fab-avisos-painel'].hidden, true);
  });
  test('ESC fecha e devolve o foco ao toggle; ESC com o painel fechado não faz nada', () => {
    const { ctx, els } = mundo();
    ctx.avisosFecharPorEsc();
    assert.equal(els['fab-avisos-toggle'].focado, undefined);
    ctx.avisosToggle();
    ctx.avisosFecharPorEsc();
    assert.equal(els['fab-avisos-toggle'].attrs['aria-expanded'], 'false');
    assert.equal(els['fab-avisos-toggle'].focado, true);
  });
});

describe('silencioso por desenho (sem popup, modal, toast ou som)', () => {
  test('o script dos avisos não usa alert/confirm/prompt/Notification/Audio/play', () => {
    for (const proibido of [/\balert\(/, /\bconfirm\(/, /\bprompt\(/, /Notification/, /new Audio/, /\.play\(/, /\.showModal\(/]) {
      assert.doesNotMatch(SCRIPT_AVISOS, proibido, String(proibido));
    }
  });
  test('NENHUM timer novo: o script dos avisos não tem setInterval', () => {
    assert.doesNotMatch(SCRIPT_AVISOS, /setInterval\(/);
  });
});

describe('ganchos no index.html (fonte)', () => {
  const iInterval = HTML.indexOf('setInterval(() => {\n        // Aviso vale em QUALQUER aba');
  test('carregarAvisos é chamada no boot do init() E dentro do setInterval existente', () => {
    assert.match(HTML, /loadData\(\);\s*\n\s*\/\/ Avisos de produtividade[\s\S]*?carregarAvisos\(\);/);
    assert.ok(iInterval > 0, 'a chamada deve ficar DENTRO do setInterval de 5 min');
  });
  test('a chamada no timer fica ANTES do `if (isRangeToday…)`: aviso vale em qualquer período', () => {
    const bloco = HTML.slice(iInterval, HTML.indexOf('}, 5 * 60 * 1000);', iInterval));
    assert.ok(bloco.indexOf('carregarAvisos') < bloco.indexOf('isRangeToday'));
    assert.ok(!/if \(isRangeToday\([^)]*\)\) \{[^}]*carregarAvisos/.test(bloco));
  });
  test('o endpoint chamado é o das rotas', () => {
    assert.match(SCRIPT_AVISOS, /`\$\{API\}\/alertas\/produtividade`/);
  });
  test('o único setInterval do app continua sendo o do Monitor (nenhum timer novo)', () => {
    assert.equal((HTML.match(/setInterval\(/g) || []).length, 1);
  });
  test('ESC chama avisosFecharPorEsc; o select de supervisor está no catálogo de selects', () => {
    assert.match(HTML, /fabFecharPorEsc\(\); if \(typeof avisosFecharPorEsc === 'function'\) avisosFecharPorEsc\(\);/);
    assert.match(HTML, /'mapa', 'avisos'\]\.map\(p => `\$\{p\}-supervisor-select`\)/);
  });
});

describe('markup', () => {
  const iFab = HTML.indexOf('<div class="fab-acoes" id="fab-acoes">');
  const iAvisos = HTML.indexOf('<div class="fab-avisos" id="fab-avisos" hidden>');

  test('existe, começa HIDDEN (desligado = nem aparece) e vem depois do balão de ações', () => {
    assert.ok(iAvisos > 0);
    assert.ok(iAvisos > iFab, 'irmão dos .tab-panel, fora de todos eles');
  });
  test('está FORA de qualquer .tab-panel (depois do último e do balão de ações)', () => {
    const ultimoPainel = HTML.lastIndexOf('class="tab-panel');
    assert.ok(iAvisos > ultimoPainel);
  });
  test('a11y: contador aria-live, toggle com aria-expanded/aria-controls, painel com role', () => {
    assert.match(HTML, /id="fab-avisos-contador" aria-live="polite" hidden/);
    assert.match(HTML, /aria-expanded="false" aria-controls="fab-avisos-painel"/);
    assert.match(HTML, /id="fab-avisos-painel" role="region"/);
    assert.match(HTML, /<button class="fab-avisos-toggle" id="fab-avisos-toggle" type="button"/);
  });
  test('não mexe no balão de ações: continua com os dois botões e o mesmo id', () => {
    assert.match(HTML, /id="btn-warm" onclick="acordarWpa\(\)"/);
    assert.match(HTML, /id="fab-btn-atualizar" onclick="fabRecarregar\(\)"/);
  });
});

describe('CSS', () => {
  test('o [hidden] não perde pro display:flex (balão não aparece desligado)', () => {
    assert.match(CSS, /\.fab-avisos\[hidden\] \{ display: none; \}/);
    assert.match(CSS, /\.fab-avisos-painel\[hidden\] \{ display: none; \}/);
  });
  test('fica na borda ESQUERDA; o balão de ações segue na DIREITA', () => {
    const avisos = CSS.slice(CSS.indexOf('.fab-avisos {'), CSS.indexOf('.fab-avisos[hidden]'));
    assert.match(avisos, /left: 0;/);
    assert.doesNotMatch(avisos, /right: 0;/);
    const acoes = CSS.slice(CSS.indexOf('.fab-acoes {'), CSS.indexOf('.fab-acoes-toggle {'));
    assert.match(acoes, /right: 0;/);
  });
  test('celular: canto inferior ESQUERDO (o de ações vai pro inferior direito)', () => {
    assert.match(CSS, /\.fab-avisos \{ top: auto; bottom: 84px; transform: none; align-items: flex-end; \}/);
  });
  test('celular: ancorado embaixo (flex-end) — o círculo NÃO sobe pro meio do painel ao abrir', () => {
    // Medido no navegador em 14/10/2026: com align-items:center o toggle pulava
    // de y=570 para y≈356 quando o painel abria.
    const movel = CSS.slice(CSS.indexOf('@media (max-width: 640px) {', CSS.indexOf('AVISOS — balão lateral ESQUERDO')));
    assert.match(movel, /align-items: flex-end/);
  });
  test('respeita prefers-reduced-motion', () => {
    assert.match(CSS, /prefers-reduced-motion: reduce\) \{\s*\.fab-avisos-toggle,\s*\.fab-avisos-painel \{ transition: none; \}/);
  });
});
