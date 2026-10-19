'use strict';

/**
 * services/saidaNota.js — "deslocamento dentro da nota": a equipe apontou que
 * está EXECUTANDO uma nota e o veículo saiu do local enquanto isso.
 *
 * Lógica PURA (sem banco, sem rede). Usada hoje só pelo backtest
 * `scripts/diag-saida-nota.js` (18/10/2026), que calibra o raio e o tempo mínimo
 * fora ANTES de existir a aba. Quando a aba vier, ela usa estas mesmas funções —
 * a calibração vale para o que for ao ar.
 *
 * Fontes:
 *   - janela de execução: checkpoints da nota (`note_details.payload.checkpoints`),
 *     do "Início do Trabalho" (evento 2) ao "Fim do Trabalho" (evento 3) — eventos
 *     conferidos no portal em 30/08/2026 (docs/handoff/API-WPA-EDP.md §6.2);
 *   - local da nota: coordenada CADASTRADA pela EDP (`payload.endereco`); sem ela,
 *     o GPS do tablet no início do trabalho;
 *   - trilha: rastreador veicular SSX, banco `gseq` (`vehicle_positions`).
 *
 * ⚠️ "Sem trilha" e "não saiu" são coisas diferentes — nunca contar um como o
 * outro. Nota sem pontos do rastreador na janela fica FORA do denominador.
 */

const EV_INICIO_TRABALHO = 2;
const EV_FIM_TRABALHO = 3;
const EV_FINALIZANDO = 4;

// ── Coordenadas ──────────────────────────────────────────────────────────────

/**
 * UTM (WGS84/SIRGAS) → [lat, lon]. Algumas notas da EDP vêm em UTM nos campos
 * Latitude/Longitude (ex.: 349457.25 / 7928881.48). Fuso 24S cobre o ES; o
 * mesmo cálculo existe em git/gseq/src/lib/wpa-execucao.ts (utmToLatLon).
 */
function utmParaLatLon(easting, northing, zona = 24, sul = true) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = easting - 500000;
  const y = sul ? northing - 10000000 : northing;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1), tan1 = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const t1 = tan1 * tan1;
  const c1 = ep2 * cos1 * cos1;
  const r1 = a * (1 - e2) / (1 - e2 * sin1 * sin1) ** 1.5;
  const d = x / (n1 * k0);
  const lat = phi1 - (n1 * tan1 / r1) * (
    d * d / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720);
  const lon = (d
    - (1 + 2 * t1 + c1) * d ** 3 / 6
    + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / cos1;
  const lon0 = ((zona - 1) * 6 - 180 + 3) * Math.PI / 180;
  return [lat * 180 / Math.PI, (lon0 + lon) * 180 / Math.PI];
}

/**
 * Coordenada utilizável ou null. Aceita graus decimais e UTM; recusa vazio,
 * (0,0) e lixo. Devolve {lat, lon}.
 */
function normalizaCoord(lat, lon) {
  if (lat === null || lat === undefined || lon === null || lon === undefined || lat === '' || lon === '') return null;
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return null;
  if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) return { lat: la, lon: lo };
  if (la > 100000 && la < 900000 && lo > 1000000 && lo < 10000000) {
    const [a, b] = utmParaLatLon(la, lo);
    return { lat: Math.round(a * 1e6) / 1e6, lon: Math.round(b * 1e6) / 1e6 };
  }
  return null;
}

/** Distância em metros (equiretangular — sobra precisão na escala de uma cidade). */
function distanciaM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.round(R * Math.hypot(x, y));
}

// ── Checkpoints ──────────────────────────────────────────────────────────────

/**
 * Instante (ms) de um checkpoint JÁ PROCESSADO (notaProcessor). Prefere
 * `registradoEm` (RegisteredAt2 — o que o portal mostra, ver API-WPA-EDP.md
 * "TimeStamp × RegisteredAt"); aceita ISO com offset ou o formato BR
 * "DD/MM/YYYY HH:MM[:SS]" (horário de Brasília). Cai no `timestamp` (UTC).
 */
function instanteCp(cp) {
  if (!cp) return null;
  const br = typeof cp.registradoEm === 'string'
    && cp.registradoEm.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  let ms = NaN;
  if (br) {
    const [, dd, mm, yyyy, hh, mi, ss] = br;
    ms = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss || '00'}-03:00`);
  } else if (cp.registradoEm) {
    ms = Date.parse(cp.registradoEm);
  }
  if (!Number.isFinite(ms) && cp.timestamp) ms = Date.parse(cp.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Janela de execução da nota: do ÚLTIMO "Início do Trabalho" ao "Fim do Trabalho"
 * que vem depois dele (sem fim, o último "Finalizando Trabalho"). O último início
 * é o da tentativa que concluiu — as anteriores terminaram em rejeição/retorno.
 *
 * @returns {{inicio:number, fim:number, cpInicio:{lat,lon}|null} | {motivo:string}}
 */
function janelaExecucao(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return { motivo: 'sem_checkpoint' };
  const cps = checkpoints
    .map(cp => ({ cp, t: instanteCp(cp), ev: Number(cp && cp.event) }))
    .filter(x => x.t !== null)
    .sort((a, b) => a.t - b.t);
  let iIni = -1;
  for (let i = cps.length - 1; i >= 0; i--) if (cps[i].ev === EV_INICIO_TRABALHO) { iIni = i; break; }
  if (iIni < 0) return { motivo: 'sem_inicio' };
  const depois = cps.slice(iIni + 1);
  const fim = depois.find(x => x.ev === EV_FIM_TRABALHO)
    || [...depois].reverse().find(x => x.ev === EV_FINALIZANDO);
  if (!fim) return { motivo: 'sem_fim' };
  const ini = cps[iIni];
  if (fim.t <= ini.t) return { motivo: 'janela_invalida' };
  return {
    inicio: ini.t,
    fim: fim.t,
    cpInicio: normalizaCoord(ini.cp.latitude, ini.cp.longitude),
  };
}

/**
 * Âncora (o centro do raio). Cadastro da EDP primeiro; sem ele, o GPS do tablet
 * no início do trabalho. `preferir='inicio'` inverte a ordem (para comparar).
 */
function ancoraDaNota({ cadastro, cpInicio }, preferir = 'cadastro') {
  const ordem = preferir === 'inicio'
    ? [['inicio', cpInicio], ['cadastro', cadastro]]
    : [['cadastro', cadastro], ['inicio', cpInicio]];
  for (const [fonte, c] of ordem) if (c) return { lat: c.lat, lon: c.lon, fonte };
  return null;
}

// ── Trilha ───────────────────────────────────────────────────────────────────

/** Quanto tempo antes do início o último ponto ainda vale como "onde o veículo estava". */
const MAX_IDADE_ANTERIOR_MIN = 360;

/**
 * Pontos do rastreador na janela, com a distância à âncora — PRECEDIDOS da
 * posição herdada no início.
 *
 * ⚠️ A trilha do gseq só grava ponto quando o veículo MUDA (posição > ~5 m ou
 * ignição; git/gseq/src/lib/tracking-fetch.ts, dedup na ingestão a cada 5 min).
 * Silêncio = parado, não falta de dado. Por isso o último ponto ANTES do início
 * é a posição do veículo no início (marcado `herdado`). Sem isto, 32% das notas
 * do 2º backtest (18/10/2026) caíam em "sem trilha" só por o veículo ter ficado
 * quieto durante a execução — que é justamente o comportamento esperado.
 * Ingestão fora do ar também é silêncio: quem chama corta isso pela frota
 * (maiorBuracoFrotaMin).
 *
 * `pontos`: [{t(ms), lat, lon, ign?}] em qualquer ordem.
 */
function pontosNaJanela(pontos, janela, ancora, maxIdadeAnteriorMin = MAX_IDADE_ANTERIOR_MIN) {
  const ord = (pontos || []).slice().sort((a, b) => a.t - b.t);
  const corte = janela.inicio - maxIdadeAnteriorMin * 60000;
  let anterior = null;
  for (const p of ord) if (p.t < janela.inicio && p.t >= corte) anterior = p;
  const serie = ord.filter(p => p.t >= janela.inicio && p.t <= janela.fim);
  if (anterior && (serie.length === 0 || serie[0].t > janela.inicio)) {
    serie.unshift({ ...anterior, t: janela.inicio, herdado: true });
  }
  return serie.map(p => ({ t: p.t, lat: p.lat, lon: p.lon, ign: p.ign === true,
    herdado: !!p.herdado, d: distanciaM(ancora, p) }));
}

/**
 * Maior buraco (min) da FROTA INTEIRA dentro da janela. `baldes` = Set de
 * índices de 5 min (floor(epoch_s/300)) em que a ingestão gravou algum ponto.
 * Frota toda calada = gseq/SSX fora do ar, e aí o silêncio do veículo não
 * significa "parado".
 */
function maiorBuracoFrotaMin(baldes, janela) {
  const ini = Math.floor(janela.inicio / 300000), fim = Math.floor(janela.fim / 300000);
  let max = 0, corrida = 0;
  for (let b = ini; b <= fim; b++) {
    if (baldes.has(b)) corrida = 0; else { corrida++; max = Math.max(max, corrida); }
  }
  return max * 5;
}

/** Maior intervalo sem ponto (min), contando as bordas da janela. */
function maiorBuracoMin(pts, janela) {
  if (pts.length === 0) return (janela.fim - janela.inicio) / 60000;
  let max = pts[0].t - janela.inicio;
  for (let i = 1; i < pts.length; i++) max = Math.max(max, pts[i].t - pts[i - 1].t);
  max = Math.max(max, janela.fim - pts[pts.length - 1].t);
  return max / 60000;
}

/**
 * Saídas do raio. Uma saída começa no primeiro ponto fora e termina no primeiro
 * ponto de volta (ou no fim da janela). Conta se ficou ≥ `minForaMin` E houve
 * movimento de verdade: ≥ 2 pontos fora, OU ignição ligada em algum deles.
 * Um ponto solto fora com ignição desligada é salto de GPS de veículo parado —
 * e, como a trilha só grava mudança, esse salto "dura" até o próximo ponto.
 *
 * @param {Array<{t,d,ign}>} pts  saída de pontosNaJanela
 * @returns {Array<{inicio, fim, minutos, distMaxM, pontos}>}
 */
function saidasDoRaio(pts, janela, { raioM, minForaMin }) {
  const out = [];
  let aberta = null;
  const fecha = (fimMs) => {
    const minutos = (fimMs - aberta.inicio) / 60000;
    if (minutos >= minForaMin && (aberta.pontos >= 2 || aberta.ign)) {
      const { ign, ...s } = aberta;
      out.push({ ...s, fim: fimMs, minutos });
    }
    aberta = null;
  };
  for (const p of pts) {
    if (p.d > raioM) {
      if (!aberta) aberta = { inicio: p.t, distMaxM: 0, pontos: 0, ign: false };
      aberta.pontos++;
      aberta.ign = aberta.ign || p.ign === true;
      aberta.distMaxM = Math.max(aberta.distMaxM, p.d);
    } else if (aberta) {
      fecha(p.t);
    }
  }
  if (aberta) fecha(janela.fim);
  return out;
}

/**
 * Desconta das saídas o tempo coberto por intervalos que a equipe APONTOU
 * (refeição, retorno à base… — `sessao_intervalo`). Saída cujo tempo líquido
 * fica abaixo de `minForaMin` some: a equipe declarou a pausa.
 *
 * Por quê (5º backtest, 18/10/2026): das saídas das equipes comerciais, quase
 * todas começavam entre 11h e 13h e duravam 20–55 min — cara de almoço. Almoço
 * apontado não é deslocamento escondido; almoço NÃO apontado, dentro da nota, é.
 *
 * @param {Array<{inicio,fim,minutos}>} saidas
 * @param {Array<{ini:number, fim:number}>} intervalos  ms
 * @returns {{saidas: Array, descontadoMin: number}}
 */
function descontarIntervalos(saidas, intervalos, minForaMin) {
  const out = [];
  let descontado = 0;
  for (const s of saidas || []) {
    let cobre = 0;
    for (const iv of intervalos || []) {
      cobre += Math.max(0, Math.min(s.fim, iv.fim) - Math.max(s.inicio, iv.ini));
    }
    cobre = Math.min(cobre, s.fim - s.inicio) / 60000;   // intervalos sobrepostos não descontam 2×
    descontado += cobre;
    const liquido = s.minutos - cobre;
    if (liquido >= minForaMin) out.push({ ...s, minutosLiquidos: liquido });
  }
  return { saidas: out, descontadoMin: Math.round(descontado) };
}

/** Km percorridos na janela (soma dos trechos entre pontos consecutivos). */
function kmNaJanela(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distanciaM(pts[i - 1], pts[i]);
  return Math.round(m / 100) / 10;
}

/**
 * Avalia uma nota. `minPontos` = mínimo de pontos na série (contando a posição
 * herdada no início) para avaliar. status: 'sem_trilha' | 'ok' | 'saiu'.
 */
function avaliarNota({ pontos, janela, ancora }, params) {
  const minPontos = params.minPontos ?? 1;
  const pts = pontosNaJanela(pontos, janela, ancora, params.maxIdadeAnteriorMin);
  const buracoMin = Math.round(maiorBuracoMin(pts, janela));
  if (pts.length < minPontos) return { status: 'sem_trilha', pontos: pts.length, buracoMin };
  const saidas = saidasDoRaio(pts, janela, params);
  let pMax = pts[0];
  for (const p of pts) if (p.d > pMax.d) pMax = p;
  // Veículo já fora do raio no início do trabalho: não "saiu" — nunca esteve.
  // É outra pergunta (apontou execução longe do local, ou o cadastro da nota está
  // errado) e não pode inflar a taxa de saída. 3º backtest (18/10/2026): casos
  // de 18–87 min "fora" com 0 km rodados eram o veículo parado longe a janela toda.
  const foraNoInicio = pts[0].d > params.raioM;
  return {
    status: foraNoInicio ? 'fora_no_inicio' : saidas.length ? 'saiu' : 'ok',
    pontos: pts.length,
    buracoMin,
    distMaxM: pMax.d,
    pontoMax: { lat: pMax.lat, lon: pMax.lon, t: pMax.t },
    minFora: Math.round(saidas.reduce((s, x) => s + x.minutos, 0)),
    km: kmNaJanela(pts),
    saidas,
    pts,
  };
}

/** Ponto do rastreador mais próximo de `alvoMs`, dentro de `janelaMin`. */
function pontoMaisProximo(pontos, alvoMs, janelaMin = 10) {
  let best = null, bestDiff = Infinity;
  for (const p of pontos || []) {
    const diff = Math.abs(p.t - alvoMs);
    if (diff < bestDiff) { best = p; bestDiff = diff; }
  }
  return bestDiff <= janelaMin * 60000 ? best : null;
}

/**
 * O veículo da trilha é mesmo o da equipe? Compara a posição do rastreador no
 * início do trabalho com o GPS do TABLET no mesmo evento (sem ele, com a âncora).
 *
 * Achado do 1º backtest (18/10/2026): ≥10% das notas tinham o veículo a 78–755 km
 * da nota no instante do início, com o tablet a poucos metros dela — e a trilha
 * inteira longe (máx 351 km com só 26 km rodados). Não é saída: é a placa do WPA
 * apontando para outro veículo. Sem este corte, "saiu" mede erro de cadastro.
 *
 * @returns {{distM:number, confere:boolean} | null}  null = sem ponto para comparar
 */
function veiculoConfere({ pontos, janela, ref, limiteM, janelaMin = 15 }) {
  if (!ref) return null;
  // Ponto perto do início; sem ele, a posição herdada (ou o 1º da janela).
  let p = pontoMaisProximo(pontos, janela.inicio, janelaMin);
  if (!p) p = pontosNaJanela(pontos, janela, ref)[0] || null;
  if (!p) return null;
  const distM = distanciaM(ref, p);
  return { distM, confere: distM <= limiteM };
}

/** Placa só com letras e dígitos, maiúscula ("TZW-7G19" → "TZW7G19"). Vazio → null. */
function placaChave(placa) {
  const s = String(placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(s) ? s : null;
}

/** Percentil (0..100) de uma lista numérica; null se vazia. */
function percentil(valores, p) {
  const v = valores.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}

// ── Placa da equipe e veículos por perto ─────────────────────────────────────

/**
 * Placa da equipe em `data` pelo cadastro do gseq (`equipes_veiculos`, aba
 * Veículos → Equipes × Veículos): correção do DIA vence VIGÊNCIA; entre
 * vigências, a de `desde` mais recente. Casa pela sigla (maiúscula).
 * @returns {{placa:string, fonte:'gseq-dia'|'gseq-vigencia'} | null}
 */
function placaCadastradaNaData(alocacoes, sigla, data) {
  let dia = null, vig = null;
  for (const a of alocacoes || []) {
    if (a.sigla !== sigla || a.desde > data || (a.ate && a.ate < data)) continue;
    if (a.tipo === 'DIA') dia = a;
    else if (!vig || a.desde > vig.desde) vig = a;
  }
  const a = dia || vig;
  return a ? { placa: a.placa, fonte: dia ? 'gseq-dia' : 'gseq-vigencia' } : null;
}

/** Só a placa de `placaCadastradaNaData` (forma usada pelos scripts de diagnóstico). */
function placaGseqNaData(alocacoes, sigla, data) {
  const r = placaCadastradaNaData(alocacoes, sigla, data);
  return r ? r.placa : null;
}

/**
 * Placa (sem separador) de dentro do nome da unidade do rastreador
 * ("CAMINHAO TZW-7G19 / 24H" → "TZW7G19"). Letras grudadas antes da placa não
 * formam placa falsa: começar 1 letra antes exigiria um dígito onde a placa tem
 * a 3ª letra. LGPD: o nome às vezes traz o motorista — só a placa sai daqui.
 */
function placaDoNome(nome) {
  const m = String(nome || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/[A-Z]{3}\d[A-Z0-9]\d{2}/);
  return m ? m[0] : null;
}

/**
 * Posição do veículo no instante `t`: último ponto ≤ t (até 6h antes — a trilha
 * só grava mudança), senão o primeiro até 15 min depois. `pts` ordenado. Busca binária.
 */
function posicaoNoInstante(pts, t, maxAntesMin = MAX_IDADE_ANTERIOR_MIN, maxDepoisMin = 15) {
  let lo = 0, hi = pts.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx >= 0 && t - pts[idx].t <= maxAntesMin * 60000) return pts[idx];
  const prox = pts[idx + 1];
  if (prox && prox.t - t <= maxDepoisMin * 60000) return prox;
  return null;
}

/** Placas de veículos a até `raioM` de `ref` no instante `t`. `frota`: Map placa → pts ordenados. */
function veiculosPerto(frota, ref, t, raioM) {
  const out = [];
  for (const [placa, pts] of frota) {
    const p = posicaoNoInstante(pts, t);
    if (p && distanciaM(ref, p) <= raioM) out.push(placa);
  }
  return out;
}

// ── Configuração e classificação (aba Saída da nota, P2-70) ─────────────────

/**
 * Regra calibrada nas 6 rodadas de backtest (11–17/10/2026) —
 * docs/handoff/SPEC-saida-da-nota-2026-10-18.md §2–§4. Editável por admin em
 * `app_settings.saida_nota`; o que não vier usa estes valores.
 *
 * `patrulha`: [prefixo da equipe, tipo da nota], `*` = qualquer equipe.
 *   EP em PO — decisão do José (18/10/2026): plantão percorre a rede atrás do defeito.
 *   * em OS  — hipótese do José ("acredito que sim", 18/10/2026): OS de SJC é emergência.
 */
const CONFIG_PADRAO = Object.freeze({
  raioM: 500,
  minForaMin: 15,
  limiteVeiculoM: 5000,
  maxBuracoFrotaMin: 20,
  patrulha: [['EP', 'PO'], ['*', 'OS']],
});

/** Normaliza a config de `app_settings`. Pura. Campo inválido → erro, nunca valor silencioso. */
function validarConfig(raw) {
  const erros = [];
  const cfg = { ...CONFIG_PADRAO, patrulha: CONFIG_PADRAO.patrulha.map(p => [...p]) };
  if (raw && typeof raw === 'object') {
    const inteiro = (k, min, max) => {
      if (raw[k] === undefined) return;
      const n = Number(raw[k]);
      if (!Number.isInteger(n) || n < min || n > max) erros.push(`${k} deve ser inteiro entre ${min} e ${max}`);
      else cfg[k] = n;
    };
    inteiro('raioM', 50, 5000);
    inteiro('minForaMin', 1, 240);
    inteiro('limiteVeiculoM', 500, 100000);
    inteiro('maxBuracoFrotaMin', 5, 240);
    if (raw.patrulha !== undefined) {
      const ok = Array.isArray(raw.patrulha) && raw.patrulha.every(p =>
        Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'string' && x.trim()));
      if (!ok) erros.push('patrulha deve ser lista de [prefixo, tipo]');
      else cfg.patrulha = raw.patrulha.map(([p, t]) => [p.trim().toUpperCase(), t.trim().toUpperCase()]);
    }
  }
  return { ok: erros.length === 0, config: cfg, erros };
}

/** Rótulo dos parâmetros em vigor — gravado em cada linha (reprocessar fica rastreável). */
function regraVersao(cfg) {
  return `r${cfg.raioM}-m${cfg.minForaMin}-v${cfg.limiteVeiculoM}-f${cfg.maxBuracoFrotaMin}`
    + `-p${cfg.patrulha.map(p => p.join(':')).join(',')}`;
}

/** A nota é patrulha (prefixo da equipe × tipo da nota)? */
function ehPatrulha(equipe, tipo, regras) {
  const pre = String(equipe || '').toUpperCase(), t = String(tipo || '').toUpperCase();
  return (regras || []).some(([p, tp]) => (p === '*' || pre.startsWith(p)) && t === tp);
}

/**
 * Classifica UMA nota concluída. Devolve exatamente um status, na ordem de
 * precedência da SPEC §4:
 *   sem_janela → sem_placa → sem_trilha → rastreador_fora → veiculo_divergente
 *   → patrulha → longe_do_local | fora_no_inicio | saiu | saiu_em_intervalo | ok
 *
 * `fora_no_inicio` e `longe_do_local` (3º e 5º backtests, 18/10/2026): o veículo
 * já estava fora do raio quando o trabalho começou — não "saiu", nunca esteve.
 * Se o TABLET também estava longe, é a nota executada longe do local (ex.: LN
 * executada em 1 min a 61 km da nota); se o tablet estava perto, a equipe foi
 * a pé ou em outro carro.
 *
 * @param {object} e
 * @param {object} e.janela        saída de janelaExecucao (ou {motivo})
 * @param {{lat,lon}|null} e.cadastro   coordenada cadastrada da nota
 * @param {string|null} e.placa    placa do cadastro (null = sem cadastro)
 * @param {Array} e.pontos         trilha do veículo [{t, lat, lon, ign}]
 * @param {Set<number>} e.baldesFrota   baldes de 5 min com ingestão da frota
 * @param {Array} e.intervalos     pausas apontadas da equipe [{ini, fim}]
 * @param {string} e.equipe, e.tipo
 */
function classificarNota(e, cfg = CONFIG_PADRAO) {
  const { janela } = e;
  if (!janela || janela.motivo) return { status: 'sem_janela', motivo: (janela && janela.motivo) || 'sem_detalhe' };
  const ancora = ancoraDaNota({ cadastro: e.cadastro, cpInicio: janela.cpInicio });
  if (!ancora) return { status: 'sem_janela', motivo: 'sem_coordenada' };
  const dCadastroTabletM = e.cadastro && janela.cpInicio ? distanciaM(e.cadastro, janela.cpInicio) : null;
  const base = { ancora, dCadastroTabletM };
  if (!e.placa) return { ...base, status: 'sem_placa' };

  const r = avaliarNota({ pontos: e.pontos, janela, ancora },
    { raioM: cfg.raioM, minForaMin: cfg.minForaMin, minPontos: 1 });
  if (r.status === 'sem_trilha') return { ...base, status: 'sem_trilha' };

  const metricas = {
    ...base,
    distMaxM: r.distMaxM, km: r.km, pontoMax: r.pontoMax,
    trilha: r.pts.map(p => ({ t: p.t, lat: p.lat, lon: p.lon, ign: p.ign })),
  };
  const buracoFrotaMin = maiorBuracoFrotaMin(e.baldesFrota || new Set(), janela);
  if (buracoFrotaMin > cfg.maxBuracoFrotaMin) return { ...metricas, status: 'rastreador_fora', buracoFrotaMin };

  const vc = veiculoConfere({ pontos: e.pontos, janela, ref: janela.cpInicio || ancora, limiteM: cfg.limiteVeiculoM });
  if (vc) metricas.dVeiculoTabletM = vc.distM;
  if (vc && !vc.confere) return { ...metricas, status: 'veiculo_divergente' };

  if (ehPatrulha(e.equipe, e.tipo, cfg.patrulha)) return { ...metricas, status: 'patrulha' };

  if (r.pts[0].d > cfg.raioM) {
    const tabletLonge = dCadastroTabletM !== null && dCadastroTabletM > cfg.raioM;
    return { ...metricas, status: tabletLonge ? 'longe_do_local' : 'fora_no_inicio' };
  }

  if (r.saidas.length) {
    const d = descontarIntervalos(r.saidas, e.intervalos, cfg.minForaMin);
    const fmt = (s) => ({ inicio: s.inicio, fim: s.fim, minutos: Math.round(s.minutosLiquidos ?? s.minutos), distMaxM: s.distMaxM });
    if (d.saidas.length === 0) {
      return { ...metricas, status: 'saiu_em_intervalo', saidas: r.saidas.map(fmt), minFora: 0, pausaDescontadaMin: d.descontadoMin };
    }
    return {
      ...metricas, status: 'saiu', saidas: d.saidas.map(fmt),
      minFora: Math.round(d.saidas.reduce((s, x) => s + x.minutosLiquidos, 0)),
      pausaDescontadaMin: d.descontadoMin,
    };
  }
  return { ...metricas, status: 'ok', minFora: 0 };
}

/**
 * Notas da MESMA equipe com janelas que se sobrepõem viram UMA ocorrência
 * (SPEC A4 — 5º backtest: EPPIU31 executou SO + SM juntas e a mesma saída
 * contou duas vezes). Grava `ocorrenciaId` em cada linha que tem janela.
 * `linhas`: [{equipe, janela:{inicio, fim}}]. Muta e devolve as linhas.
 */
function agruparOcorrencias(linhas) {
  const porEquipe = new Map();
  for (const l of linhas) {
    if (!l.janela || l.janela.motivo || !Number.isFinite(l.janela.inicio)) continue;
    if (!porEquipe.has(l.equipe)) porEquipe.set(l.equipe, []);
    porEquipe.get(l.equipe).push(l);
  }
  for (const [equipe, ls] of porEquipe) {
    ls.sort((a, b) => a.janela.inicio - b.janela.inicio);
    let grupoIni = null, grupoFim = -Infinity;
    for (const l of ls) {
      if (l.janela.inicio >= grupoFim) grupoIni = l.janela.inicio;   // não sobrepõe: grupo novo
      grupoFim = Math.max(grupoFim, l.janela.fim);
      l.ocorrenciaId = `${equipe}|${new Date(grupoIni).toISOString()}`;
    }
  }
  return linhas;
}

module.exports = {
  EV_INICIO_TRABALHO, EV_FIM_TRABALHO, EV_FINALIZANDO,
  utmParaLatLon, normalizaCoord, distanciaM,
  instanteCp, janelaExecucao, ancoraDaNota,
  MAX_IDADE_ANTERIOR_MIN, pontosNaJanela, maiorBuracoMin, maiorBuracoFrotaMin, saidasDoRaio, descontarIntervalos, kmNaJanela, avaliarNota,
  pontoMaisProximo, veiculoConfere, placaChave, percentil,
  placaCadastradaNaData, placaGseqNaData, placaDoNome, posicaoNoInstante, veiculosPerto,
  CONFIG_PADRAO, validarConfig, regraVersao, ehPatrulha, classificarNota, agruparOcorrencias,
};
