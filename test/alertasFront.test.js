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
const BASE = 'WPA Monitor · Engelmig';   // título curto desde 14/10/2026 (cabe na aba)

/** Executa o script dos avisos com um DOM falso; devolve o mundo para inspeção. */
function mundo({ fetchImpl, siglas = null, selecionadas, daConta, relogio } = {}) {
  const els = {};
  const el = (id, extra = {}) => (els[id] = { id, hidden: false, textContent: '', innerHTML: '', classList: { add() {}, remove() {} },
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, focus() { this.focado = true; }, ...extra });
  for (const id of ['fab-avisos', 'fab-avisos-painel', 'fab-avisos-toggle', 'fab-avisos-icone',
    'fab-avisos-contador', 'fab-avisos-lista', 'avisos-supervisor-select', 'fab-avisos-sub', 'fab-avisos-rodape']) el(id);
  // classList que GUARDA as classes (o painel usa 'tem-avisos' pro pulso)
  const cls = new Set();
  els['fab-avisos'].classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) };
  els['fab-avisos-toggle'].attrs['aria-expanded'] = 'false';
  el('favicon');
  els['favicon'].attrs.href = 'favicon.svg';

  const ctx = {
    document: { title: BASE, getElementById: (id) => els[id] || null },
    API: '/api',
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ ativo: false, alertas: [] }) })),
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    _supSiglasDoSelect: () => siglas,
    _supPopularSelect: async () => {},
    requestAnimationFrame: (fn) => fn(),
    // relogio: { fila: [] } → timers ficam PENDENTES até o teste chamar disparar();
    // sem relogio, executam na hora (comportamento antigo dos testes).
    setTimeout: relogio ? (fn) => { relogio.fila.push(fn); return relogio.fila.length; } : (fn) => fn(),
    clearTimeout: relogio ? (id) => { if (id) relogio.fila[id - 1] = null; } : () => {},
    console: { warn() {}, log() {} },
  };
  if (selecionadas) ctx.selectedRegionals = selecionadas;
  if (daConta) ctx.userRegionals = daConta;
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
    // 14/10/2026: com o filtro de regional, a URL leva `${qs}` (?regionals=...).
    assert.match(SCRIPT_AVISOS, /`\$\{API\}\/alertas\/produtividade\$\{qs\}`/);
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
    const bloco = CSS.slice(CSS.indexOf('AVISOS — balão lateral ESQUERDO'));
    const rm = bloco.slice(bloco.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(rm, /\.fab-avisos-toggle,\s*\.fab-avisos-painel,\s*\.aviso-item \{ transition: none; \}/);
    assert.match(rm, /\.fab-avisos\.tem-avisos \.fab-avisos-toggle \{ animation: none; \}/, 'o pulso desliga em reduced-motion');
  });
});

// ── Redesenho visual (14/10/2026) ────────────────────────────────────────────
describe('visual do painel (redesenho)', () => {
  test('gravidade pela distância do limite: 0 alta, < metade média, resto baixa', () => {
    const { ctx } = mundo();
    assert.equal(ctx.avisosGravidade(0, 4), 'alta');
    assert.equal(ctx.avisosGravidade(1, 4), 'media');
    assert.equal(ctx.avisosGravidade(2, 4), 'baixa');
    assert.equal(ctx.avisosGravidade(3, 4), 'baixa');
    assert.equal(ctx.avisosGravidade(2, 6), 'media');
  });
  test('cartão: número/limite em destaque, classe de gravidade, chips e aria-label com o resumo', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta({ executadas: 0, rejeitadas: 2 })]) });
    await ctx.carregarAvisos();
    const html = els['fab-avisos-lista'].innerHTML;
    assert.match(html, /class="aviso-item aviso-alta"/);
    assert.match(html, /<strong>0<\/strong><small>\/4<\/small>/);
    assert.match(html, /\+2 rejeitadas/);
    assert.match(html, /meio do turno 12:30/);
    assert.match(html, /turno 08:00–17:00/);
    assert.match(html, /aria-label="ECGPR53, 0 executadas \(\+2 rejeitadas\)/);
    assert.match(html, /role="list"/);
  });
  test('interrompidas (15/10/2026): chip abaixo, como o das rejeitadas; some quando 0', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta({ rejeitadas: 1, interrompidas: 2 })]) });
    await ctx.carregarAvisos();
    const html = els['fab-avisos-lista'].innerHTML;
    assert.match(html, /class="aviso-chip aviso-chip-int"[^>]*>\+2 interrompidas</);
    assert.ok(html.indexOf('aviso-chip-rej') < html.indexOf('aviso-chip-int'), 'interrompidas vem depois das rejeitadas');
    assert.match(html, /aria-label="ECGPR53, 2 executadas \(\+1 rejeitada\) \(\+2 interrompidas\)/);
    assert.match(ctx.avisosTexto(alerta({ interrompidas: 1 })), /\(\+1 interrompida\)/);
    for (const v of [0, undefined]) {
      const m = mundo({ fetchImpl: resposta(true, [alerta({ interrompidas: v })]) });
      await m.ctx.carregarAvisos();
      assert.doesNotMatch(m.els['fab-avisos-lista'].innerHTML, /interrompida/);
    }
  });
  test('CSS do chip de interrompidas existe', () => {
    assert.match(CSS, /\.aviso-chip-int\s*\{/);
  });
  test('sem supervisor: mostra "sem supervisor" (não um "Sup." vazio)', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta({ supervisor: null })]) });
    await ctx.carregarAvisos();
    assert.match(els['fab-avisos-lista'].innerHTML, /sem supervisor/);
    assert.doesNotMatch(els['fab-avisos-lista'].innerHTML, /Sup\. /);
  });
  test('cabeçalho resume (plural/singular) e o rodapé explica a regra com o limite em vigor', async () => {
    const { ctx, els } = mundo({ fetchImpl: async () => ({ ok: true, json: async () => ({ ativo: true, limite: 3, alertas: [alerta()] }) }) });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos-sub'].textContent, '1 equipe abaixo de 3 notas');
    assert.match(els['fab-avisos-rodape'].textContent, /menos de 3 notas executadas/);
    ctx.fetch = resposta(true, [alerta(), alerta({ equipe: 'X' })]);
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos-sub'].textContent, '2 equipes abaixo de 4 notas', 'sem limite na resposta → 4');
  });
  test('vazio e falha também mudam o cabeçalho', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, []) });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos-sub'].textContent, 'nenhuma equipe abaixo do esperado');
    ctx.fetch = async () => { throw new Error('rede'); };
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos-sub'].textContent, 'sem conexão com o servidor');
  });
  test('o pulso (classe tem-avisos) só existe quando há aviso visível', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta()]) });
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos'].classList.contains('tem-avisos'), true);
    ctx.fetch = resposta(true, []);
    await ctx.carregarAvisos();
    assert.equal(els['fab-avisos'].classList.contains('tem-avisos'), false);
  });
  test('posição: um pouco ACIMA do meio (não no topo), botão parado e painel crescendo pra baixo', () => {
    const avisos = CSS.slice(CSS.indexOf('.fab-avisos {'), CSS.indexOf('.fab-avisos[hidden]'));
    assert.match(avisos, /top: calc\(50% - 130px\);/);
    assert.match(avisos, /align-items: flex-start;/);
    assert.doesNotMatch(avisos, /translateY/);
    assert.match(CSS, /\.fab-avisos-painel \{[^}]*max-height: calc\(50vh \+ 110px\);/);
  });
  test('a lista ROLA dentro do painel (muitas equipes cabem)', () => {
    assert.match(CSS, /\.fab-avisos-lista \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  });
  test('o pulso é só visual: nenhum som/Notification/vibração no script', () => {
    assert.doesNotMatch(SCRIPT_AVISOS, /Audio|Notification|vibrate/);
  });
});

// ── Filtro de regional (14/10/2026): o balão segue o filtro da tela ──────────
describe('balão segue o filtro de regional (e o servidor, os acessos da conta)', () => {
  test('pede com as regionais do FILTRO (?regionals=GUA,CAC, codificado)', async () => {
    let url;
    const { ctx } = mundo({
      selecionadas: ['GUA', 'CAC'], daConta: ['GUA', 'CAC', 'SJC'],
      fetchImpl: async (u) => { url = u; return { ok: true, json: async () => ({ ativo: true, alertas: [] }) }; },
    });
    await ctx.carregarAvisos();
    assert.equal(url, '/api/alertas/produtividade?regionals=GUA%2CCAC');
  });
  test('sem filtro definido (antes do init) → sem parâmetro: o servidor usa os acessos da conta', async () => {
    let url;
    const { ctx } = mundo({ fetchImpl: async (u) => { url = u; return { ok: true, json: async () => ({ ativo: true, alertas: [] }) }; } });
    await ctx.carregarAvisos();
    assert.equal(url, '/api/alertas/produtividade');
  });
  test('lê o filtro NA HORA da busca (mudou a seleção → a próxima busca já vai com a nova)', async () => {
    const urls = [];
    const { ctx } = mundo({
      selecionadas: ['GUA'], daConta: ['GUA', 'SJC'],
      fetchImpl: async (u) => { urls.push(u); return { ok: true, json: async () => ({ ativo: true, alertas: [] }) }; },
    });
    await ctx.carregarAvisos();
    ctx.selectedRegionals = ['SJC'];
    await ctx.carregarAvisos();
    assert.deepEqual(urls, ['/api/alertas/produtividade?regionals=GUA', '/api/alertas/produtividade?regionals=SJC']);
  });
  test('resposta VELHA (filtro trocado no meio) é descartada e não sobrescreve a nova', async () => {
    const pendentes = [];
    const { ctx, els } = mundo({
      selecionadas: ['GUA'], daConta: ['GUA', 'SJC'],
      fetchImpl: () => new Promise((resolve) => pendentes.push(resolve)),
    });
    const responder = (alertas) => ({ ok: true, json: async () => ({ ativo: true, alertas }) });
    const p1 = ctx.carregarAvisos();                 // busca de GUA
    ctx.selectedRegionals = ['SJC'];
    const p2 = ctx.carregarAvisos();                 // busca de SJC
    pendentes[1](responder([alerta({ equipe: 'ECCSJ82', regional: 'SJC' })]));   // a NOVA chega antes
    await p2;
    pendentes[0](responder([alerta({ equipe: 'ECGPR53', regional: 'GUA' })]));   // a VELHA chega depois
    await p1;
    assert.match(els['fab-avisos-lista'].innerHTML, /ECCSJ82/);
    assert.doesNotMatch(els['fab-avisos-lista'].innerHTML, /ECGPR53/, 'a resposta de GUA chegou atrasada e foi ignorada');
  });
  test('erro de uma busca VELHA também não sobrescreve a nova', async () => {
    const pendentes = [];
    const { ctx, els } = mundo({ selecionadas: ['GUA'], daConta: ['GUA', 'SJC'], fetchImpl: () => new Promise((res, rej) => pendentes.push({ res, rej })) });
    const p1 = ctx.carregarAvisos();
    const p2 = ctx.carregarAvisos();
    pendentes[1].res({ ok: true, json: async () => ({ ativo: true, alertas: [alerta()] }) });
    await p2;
    pendentes[0].rej(new Error('rede'));
    await p1;
    assert.doesNotMatch(els['fab-avisos-lista'].innerHTML, /indisponíveis/);
  });
  test('várias mudanças seguidas de filtro viram UMA busca (atraso curto)', async () => {
    const relogio = { fila: [] };
    let buscas = 0;
    const { ctx } = mundo({ relogio, selecionadas: ['GUA'], fetchImpl: async () => { buscas++; return { ok: true, json: async () => ({ ativo: true, alertas: [] }) }; } });
    ctx.avisosAgendarRecarga();
    ctx.avisosAgendarRecarga();
    ctx.avisosAgendarRecarga();
    for (const fn of relogio.fila) if (fn) fn();
    await new Promise(r => setImmediate(r));
    assert.equal(buscas, 1);
  });
  test('cabeçalho mostra o filtro só quando ele ESTREITA o que a conta vê', async () => {
    const r = mundo({ selecionadas: ['GUA'], daConta: ['GUA', 'CAC'], fetchImpl: resposta(true, [alerta()]) });
    await r.ctx.carregarAvisos();
    assert.equal(r.els['fab-avisos-sub'].textContent, '1 equipe abaixo de 4 notas · GUA');
    const t = mundo({ selecionadas: ['GUA', 'CAC'], daConta: ['GUA', 'CAC'], fetchImpl: resposta(true, [alerta()]) });
    await t.ctx.carregarAvisos();
    assert.equal(t.els['fab-avisos-sub'].textContent, '1 equipe abaixo de 4 notas', 'filtro = tudo da conta: não polui');
  });
  test('ganchos: selectRegional (Monitor) e syncRegionalDropdowns (qualquer aba) agendam a recarga', () => {
    const sel = HTML.slice(HTML.indexOf('function selectRegional('), HTML.indexOf('function _cobrePeloCache') > 0 ? HTML.indexOf('* A seleção atual está contida') : undefined);
    assert.match(sel, /if \(typeof avisosAgendarRecarga === 'function'\) avisosAgendarRecarga\(\);/);
    const sync = HTML.slice(HTML.indexOf('function syncRegionalDropdowns('), HTML.indexOf('// Propaga pros outros dropdowns'));
    assert.match(sync, /selectedRegionals = finalRegs;[\s\S]*avisosAgendarRecarga\(\);/);
  });
});

// ── Favicon e título da aba (14/10/2026) ─────────────────────────────────────
describe('favicon e título da aba', () => {
  test('com aviso o favicon ganha o ponto vermelho; sem aviso volta ao normal', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta()]) });
    await ctx.carregarAvisos();
    assert.equal(els['favicon'].attrs.href, 'favicon-alerta.svg');
    ctx.fetch = resposta(true, []);
    await ctx.carregarAvisos();
    assert.equal(els['favicon'].attrs.href, 'favicon.svg');
  });
  test('desligado: favicon normal e título intacto', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(false, []) });
    await ctx.carregarAvisos();
    assert.equal(els['favicon'].attrs.href, 'favicon.svg');
    assert.equal(ctx.document.title, BASE);
  });
  test('só regrava o href quando muda (o navegador não re-busca o ícone à toa)', async () => {
    const { ctx, els } = mundo({ fetchImpl: resposta(true, [alerta()]) });
    let escritas = 0;
    const set = els['favicon'].setAttribute.bind(els['favicon']);
    els['favicon'].setAttribute = (k, v) => { escritas++; set(k, v); };
    await ctx.carregarAvisos();
    await ctx.carregarAvisos();
    await ctx.carregarAvisos();
    assert.equal(escritas, 1);
  });
  test('<head>: título curto, description, theme-color e favicon LOCAL com id', () => {
    const head = HTML.slice(0, HTML.indexOf('</head>'));
    assert.match(head, /<title>WPA Monitor · Engelmig<\/title>/);
    assert.match(head, /<meta name="description" content="[^"]{30,}"/);
    assert.match(head, /<meta name="theme-color" content="#231F20"/);
    assert.match(head, /<link rel="icon" type="image\/svg\+xml" href="favicon\.svg" id="favicon"/);
    assert.doesNotMatch(head, /rel="icon"[^>]*href="https?:/, 'Fortinet bloqueia CDN: ícone tem de ser local');
  });
  test('os dois SVGs existem em public/, usam as cores da marca e o de alerta tem o ponto', () => {
    const fav = ler('public', 'favicon.svg');
    const alerta = ler('public', 'favicon-alerta.svg');
    for (const svg of [fav, alerta]) {
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 64 64">/);
      assert.match(svg, /#FEC40E/);
      assert.match(svg, /#231F20/);
      assert.doesNotMatch(svg, /<script|href="http/, 'SVG sem script nem recurso externo');
      // 14/10/2026 (José: "temos que usar o raio da logo da engelmig"): o raio é o
      // RECORTE do logo.png real, embutido como PNG — não um desenho aproximado.
      assert.match(svg, /<image [^>]*href="data:image\/png;base64,[A-Za-z0-9+/=]{1000,}"/);
      assert.match(svg, /Recorte de public\/logo\.png/);
    }
    assert.doesNotMatch(fav, /<circle/);
    assert.match(alerta, /<circle [^>]*fill="#ED1C24"/);
  });
});

describe('gerador do favicon (scripts/gerar-favicon.js)', () => {
  test('regenerar a partir do logo.png reproduz EXATAMENTE os favicons commitados', () => {
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'favicon-'));
    execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'gerar-favicon.js'),
      path.join(RAIZ, 'public', 'logo.png'), tmp], { stdio: 'pipe' });
    for (const f of ['favicon.svg', 'favicon-alerta.svg']) {
      const gerado = fs.readFileSync(path.join(tmp, f), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(gerado, ler('public', f), `${f} está fora de sincronia com o logo.png — rode o gerador`);
    }
  });
});

describe('cantos do painel (15/10/2026)', () => {
  const regra = () => CSS.slice(CSS.indexOf('.fab-avisos-painel {'), CSS.indexOf('}', CSS.indexOf('.fab-avisos-painel {')));
  test('os 4 cantos iguais e borda inteira (sem o lado "colado" reto)', () => {
    assert.match(regra(), /border-radius: 14px;/);
    assert.doesNotMatch(regra(), /border-left: none/);
    assert.doesNotMatch(regra(), /border-radius: 0 /);
  });
  test('respiro entre o botão e o painel', () => {
    assert.match(regra(), /margin-left: 10px;/);
  });
  test('celular: largura = tela − botão − respiro − margem (sem rolagem lateral)', () => {
    assert.match(CSS, /\.fab-avisos\.aberto \.fab-avisos-painel \{ max-width: calc\(100vw - 76px\); \}/);
  });
});
