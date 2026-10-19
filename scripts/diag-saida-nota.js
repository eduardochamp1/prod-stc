#!/usr/bin/env node
/**
 * scripts/diag-saida-nota.js — ESTRITAMENTE READ-ONLY.
 *
 * Backtest do "deslocamento dentro da nota" (pedido do José, 18/10/2026): a
 * equipe apontou que está EXECUTANDO a nota e o veículo saiu do local enquanto
 * isso. Antes de existir a aba (que substituiria o Ranking), este script mede
 * numa semana passada quantas notas seriam marcadas e com qual raio — para a
 * regra nascer calibrada, como no backtest do alerta de produtividade.
 *
 * Cruza, por dia:
 *   1. notas concluídas (snapshots do wpa_monitor) → equipe e placa do dia;
 *   2. checkpoints da nota (note_details) → janela Início→Fim do Trabalho;
 *   3. local da nota: coordenada cadastrada pela EDP (sem ela, GPS do início);
 *   4. trilha do rastreador SSX no banco `gseq` (vehicle_positions), mesma VM.
 * A lógica está em services/saidaNota.js (pura, testada).
 *
 * USO (na VM, em ~/prod-stc):
 *   node scripts/diag-saida-nota.js                     # 7 dias até ontem, raio 300 m, 10 min
 *   node scripts/diag-saida-nota.js --dias=14 --raio=500 --min-fora=15
 *   node scripts/diag-saida-nota.js --ate=2026-10-16 --dias=3
 *   node scripts/diag-saida-nota.js --ancora=inicio     # centro = GPS do início, não o cadastro
 *   node scripts/diag-saida-nota.js --csv=/tmp/saida-nota.csv   # uma linha por nota (planilha)
 *
 * Banco gseq: por padrão conecta pelo socket local (peer auth, como `psql -d gseq`).
 * Se o seu usuário não tiver acesso, passe a URL do próprio gseq:
 *   GSEQ_DATABASE_URL="$(grep ^DATABASE_URL ~/gseq/.env.local | cut -d= -f2- | tr -d '\"')" \
 *     node scripts/diag-saida-nota.js
 *
 * Não grava nada em banco nenhum (o --csv escreve só o arquivo local pedido).
 * Um dia por vez: o jsonb dos snapshots é pesado (P2-46). Não rode em paralelo.
 * A retenção do vehicle_positions no gseq é de 60 dias — período mais antigo
 * que isso volta "sem trilha".
 * LGPD: só lê placa, lat/lon e hora do rastreador — nada de motorista/CPF.
 */

'use strict';

const S = require('../services/saidaNota');
const { dateBRT, dateBRTMinusDays } = require('../services/timeUtil');

const GRADE_RAIOS = [200, 300, 500, 1000, 2000];
const GRADE_MIN = [5, 10, 20, 30];
/** Status com trilha avaliada (os que os cortes de veículo/rastreador podem rebaixar). */
const AVALIAVEIS = new Set(['ok', 'saiu', 'fora_no_inicio']);

/** Lê `--chave=valor`. Pura. */
function lerArgs(argv) {
  const out = { dias: 7, ate: null, raio: 300, minFora: 10, minPontos: 1,
    ancora: 'cadastro', top: 25, csv: null, limiteVeiculo: 5000, maxBuracoFrota: 20,
    patrulha: [['EP', 'PO']], erros: [] };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--dias=(\d+)$/))) out.dias = Number(m[1]);
    else if ((m = a.match(/^--patrulha=(.*)$/))) {
      // "EP:PO,EB:PO" — prefixo da equipe : tipo da nota. Vazio desliga.
      out.patrulha = m[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean).map(s => s.split(':'));
      if (out.patrulha.some(p => p.length !== 2 || !p[0] || !p[1])) out.erros.push('--patrulha no formato EP:PO,EB:PO');
    }
    else if ((m = a.match(/^--max-buraco-frota=(\d+)$/))) out.maxBuracoFrota = Number(m[1]);
    else if ((m = a.match(/^--limite-veiculo=(\d+)$/))) out.limiteVeiculo = Number(m[1]);
    else if ((m = a.match(/^--ate=(\d{4}-\d{2}-\d{2})$/))) out.ate = m[1];
    else if ((m = a.match(/^--raio=(\d+)$/))) out.raio = Number(m[1]);
    else if ((m = a.match(/^--min-fora=(\d+)$/))) out.minFora = Number(m[1]);
    else if ((m = a.match(/^--min-pontos=(\d+)$/))) out.minPontos = Number(m[1]);
    else if ((m = a.match(/^--ancora=(cadastro|inicio)$/))) out.ancora = m[1];
    else if ((m = a.match(/^--top=(\d+)$/))) out.top = Number(m[1]);
    else if ((m = a.match(/^--csv=(.+)$/))) out.csv = m[1];
    else if (a === '--help' || a === '-h') out.ajuda = true;
    else out.erros.push(`argumento desconhecido: ${a}`);
  }
  if (out.dias < 1 || out.dias > 60) out.erros.push('--dias deve ficar entre 1 e 60 (retenção do rastreador)');
  if (out.raio < 50) out.erros.push('--raio abaixo de 50 m é ruído de GPS');
  if (out.minPontos < 1) out.erros.push('--min-pontos deve ser ≥ 1');
  return out;
}

/** Dias YYYY-MM-DD do período, do mais antigo ao mais novo. Hoje fica de fora. */
function diasDoPeriodo({ dias, ate }, hoje = dateBRT()) {
  const fim = ate || dateBRTMinusDays(1);
  if (fim >= hoje) throw new Error(`--ate=${fim} não pode ser hoje ou futuro (dia incompleto)`);
  const out = [];
  const base = Date.parse(`${fim}T12:00:00Z`);
  for (let i = dias - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

function configGseq(env = process.env) {
  const url = env.GSEQ_DATABASE_URL;
  if (url) {
    // URL do Prisma traz `?schema=public`, que o node-postgres não entende.
    const limpa = url.replace(/([?&])schema=[^&]*&?/, '$1').replace(/[?&]$/, '');
    return { connectionString: limpa, max: 2, application_name: 'diag-saida-nota' };
  }
  return { host: '/var/run/postgresql', database: 'gseq', max: 2, application_name: 'diag-saida-nota' };
}

const fmtHora = (ms) => new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(ms));

const fmtM = (m) => (m === null || m === undefined) ? '—'
  : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;

/** A nota é patrulha (prefixo da equipe × tipo da nota em `regras`)? Pura. */
function ehPatrulha(equipe, tipo, regras) {
  const pre = String(equipe || '').toUpperCase(), t = String(tipo || '').toUpperCase();
  return (regras || []).some(([p, tp]) => pre.startsWith(p) && t === tp);
}

/**
 * Placa da equipe em `data` pelo cadastro do gseq (`equipes_veiculos`, aba
 * Veículos → Equipes × Veículos): correção do DIA vence VIGÊNCIA; entre
 * vigências, a de `desde` mais recente. Casa pela sigla. Pura.
 */
function placaGseqNaData(alocacoes, sigla, data) {
  let dia = null, vig = null;
  for (const a of alocacoes) {
    if (a.sigla !== sigla || a.desde > data || (a.ate && a.ate < data)) continue;
    if (a.tipo === 'DIA') dia = a;
    else if (!vig || a.desde > vig.desde) vig = a;
  }
  return (dia || vig || {}).placa || null;
}

/**
 * Lê um dia e devolve uma linha por nota concluída (avaliada ou com o motivo de
 * não ter sido). `pool` = wpa_monitor, `poolGseq` = gseq.
 */
async function lerDia({ pool, poolGseq, data, oficiais, alocacoes = [], args }) {
  // Notas concluídas do dia + equipe + placa da sessão (a do WPA, que é a do dia).
  const { rows: notas } = await pool.query(`
    SELECT DISTINCT ON (n->>'id')
           n->>'id'                AS note_id,
           s.team_name,
           s.regional,
           s.data->>'vehiclePlate' AS placa_wpa
      FROM public.snapshots s,
           LATERAL jsonb_array_elements(COALESCE(s.data->'notasConcluidas', '[]'::jsonb)) n
     WHERE s.date = $1::date
       AND n->>'id' IS NOT NULL
     ORDER BY n->>'id', s.captured_at DESC`, [data]);

  const doDia = notas.filter(n => oficiais.has(String(n.team_name).toUpperCase()));
  if (doDia.length === 0) return [];

  const { rows: det } = await pool.query(`
    SELECT note_id::text AS note_id, numero, tipo,
           payload->'checkpoints' AS checkpoints,
           payload->'endereco'    AS endereco
      FROM public.note_details
     WHERE note_id = ANY($1::uuid[])`, [doDia.map(n => n.note_id)]);
  const detPorId = new Map(det.map(d => [d.note_id, d]));

  const linhas = [];
  for (const n of doDia) {
    const equipe = String(n.team_name).toUpperCase();
    const base = { data, equipe, regional: n.regional, note_id: n.note_id };
    const d = detPorId.get(n.note_id);
    if (!d) { linhas.push({ ...base, status: 'sem_detalhe' }); continue; }
    base.numero = d.numero; base.tipo = d.tipo;

    const janela = S.janelaExecucao(d.checkpoints);
    if (janela.motivo) { linhas.push({ ...base, status: janela.motivo }); continue; }

    const cadastro = d.endereco ? S.normalizaCoord(d.endereco.latitude, d.endereco.longitude) : null;
    const ancora = S.ancoraDaNota({ cadastro, cpInicio: janela.cpInicio }, args.ancora);
    if (!ancora) { linhas.push({ ...base, status: 'sem_ancora', janela }); continue; }

    // Cascata da placa: o que a operação cadastrou no gseq (Equipes × Veículos,
    // por dia/vigência) vence a placa declarada na sessão do WPA — o 2º backtest
    // (18/10/2026) achou 163 notas com a placa do WPA levando a um veículo a
    // dezenas/centenas de km do tablet. Por último, equipes_oficiais.placa.
    let placa = S.placaChave(placaGseqNaData(alocacoes, equipe, data)), fontePlaca = 'gseq';
    if (!placa) { placa = S.placaChave(n.placa_wpa); fontePlaca = 'wpa'; }
    if (!placa) { placa = S.placaChave(oficiais.get(equipe)); fontePlaca = 'cadastro'; }
    if (!placa) { linhas.push({ ...base, status: 'sem_placa', janela }); continue; }

    linhas.push({ ...base, status: 'pendente', janela, cadastro, ancora, placa, fontePlaca });
  }

  // Trilha: uma consulta por dia, só das placas envolvidas e só no intervalo
  // coberto pelas janelas, recuando MAX_IDADE_ANTERIOR_MIN para achar a posição
  // herdada no início (a trilha só grava mudança). O filtro em "recordedAt" usa
  // o índice; a folga de 3h cobre posições que chegaram atrasadas.
  const pend = linhas.filter(l => l.status === 'pendente');
  const porPlaca = new Map();
  const unidades = new Map();   // placa → Set de unidades do rastreador que casaram
  let baldesFrota = new Set();
  if (pend.length) {
    const ini = Math.min(...pend.map(l => l.janela.inicio)) - S.MAX_IDADE_ANTERIOR_MIN * 60000;
    const fim = Math.max(...pend.map(l => l.janela.fim)) + 30 * 60000;
    const placas = [...new Set(pend.map(l => l.placa))];
    const { rows: pos } = await poolGseq.query(`
      SELECT regexp_replace(upper(vehicle), '[^A-Z0-9]', '', 'g') AS v,
             lat, lon, ignition, COALESCE("eventAt", "recordedAt") AS t
        FROM vehicle_positions
       WHERE "recordedAt" >= $1 AND "recordedAt" < $2
         AND regexp_replace(upper(vehicle), '[^A-Z0-9]', '', 'g') LIKE ANY ($3::text[])`,
      [new Date(ini), new Date(fim + 3 * 3600000), placas.map(p => `%${p}%`)]);
    for (const p of pos) {
      const t = new Date(p.t).getTime();
      if (t < ini || t > fim) continue;
      // O nome no rastreador traz sufixo ("TLF3E65 / 24 HORAS") — casa por substring.
      const placa = placas.find(pl => p.v.includes(pl));
      if (!placa) continue;
      if (!porPlaca.has(placa)) { porPlaca.set(placa, []); unidades.set(placa, new Set()); }
      porPlaca.get(placa).push({ t, lat: Number(p.lat), lon: Number(p.lon), ign: p.ignition === true });
      unidades.get(placa).add(p.v);
    }
    // Pulso da ingestão: baldes de 5 min em que a FROTA gravou algo.
    const { rows: bs } = await poolGseq.query(`
      SELECT DISTINCT floor(extract(epoch FROM "recordedAt") / 300)::bigint AS b
        FROM vehicle_positions
       WHERE "recordedAt" >= $1 AND "recordedAt" < $2`,
      [new Date(ini), new Date(fim)]);
    baldesFrota = new Set(bs.map(r => Number(r.b)));
  }

  for (const l of pend) {
    const pontos = porPlaca.get(l.placa) || [];
    l.unidades = unidades.has(l.placa) ? unidades.get(l.placa).size : 0;
    l.duracaoMin = Math.round((l.janela.fim - l.janela.inicio) / 60000);
    l.buracoFrotaMin = S.maiorBuracoFrotaMin(baldesFrota, l.janela);
    const r = S.avaliarNota({ pontos, janela: l.janela, ancora: l.ancora },
      { raioM: args.raio, minForaMin: args.minFora, minPontos: args.minPontos });
    Object.assign(l, r);
    // "Sem trilha" tem duas causas que pedem ações diferentes: a placa não tem
    // NENHUM ponto no período (casamento placa × rastreador) ou tem, mas nenhum
    // nas 6h antes do início nem durante a execução.
    if (l.status === 'sem_trilha') l.status = pontos.length ? 'sem_trilha_janela' : 'sem_trilha_placa';
    // Ingestão parada durante a execução: o silêncio não quer dizer "parado".
    if (AVALIAVEIS.has(l.status) && l.buracoFrotaMin > args.maxBuracoFrota) {
      l.statusOriginal = l.status;
      l.status = 'rastreador_fora';
      continue;
    }
    // Veículo da trilha longe do tablet no início → não é o veículo da equipe.
    const vc = S.veiculoConfere({ pontos, janela: l.janela,
      ref: l.janela.cpInicio || l.ancora, limiteM: args.limiteVeiculo });
    if (vc) l.dVeiculoM = vc.distM;
    if (vc && !vc.confere && AVALIAVEIS.has(l.status)) {
      l.statusOriginal = l.status;
      l.status = 'veiculo_divergente';
    }
    // Plantão em nota de ocorrência percorre a rede atrás do defeito — sair do
    // local é o serviço (decisão do José, 18/10/2026). Fica fora da conta.
    if (AVALIAVEIS.has(l.status) && ehPatrulha(l.equipe, l.tipo, args.patrulha)) {
      l.statusOriginal = l.status;
      l.status = 'patrulha';
    }
    // Qualidade da âncora: quão longe o cadastro está de onde a equipe apontou o
    // início, e de onde o veículo estava nessa hora.
    if (l.cadastro && l.janela.cpInicio) l.dCadInicio = S.distanciaM(l.cadastro, l.janela.cpInicio);
    const pIni = S.pontoMaisProximo(pontos, l.janela.inicio, 10);
    if (pIni) l.dAncoraVeiculoInicio = S.distanciaM(l.ancora, pIni);
  }
  return linhas;
}

/**
 * Uma linha por nota no período. A mesma nota aparece em `notasConcluidas` de
 * snapshots de mais de um dia (1º backtest, 18/10/2026: nota 045006456830 em
 * 14/10 E 15/10, mesmo horário) — sem isto, ela conta duas vezes e a equipe
 * "sai" em dobro. Fica a linha do dia (BRT) em que a execução começou; sem
 * janela, a primeira vista.
 */
function deduplicar(linhas) {
  const porId = new Map();
  for (const l of linhas) {
    const atual = porId.get(l.note_id);
    if (!atual) { porId.set(l.note_id, l); continue; }
    const doDia = (x) => x.janela && x.janela.inicio && dateBRT(new Date(x.janela.inicio)) === x.data;
    if (!doDia(atual) && doDia(l)) porId.set(l.note_id, l);
  }
  return [...porId.values()];
}

/** Junta tudo e calcula o que o relatório mostra. Pura. */
function resumir(linhas, args) {
  const funil = {};
  for (const l of linhas) funil[l.status] = (funil[l.status] || 0) + 1;
  const aval = linhas.filter(l => l.status === 'ok' || l.status === 'saiu');

  // Para cada raio, o denominador são as notas em que o veículo estava DENTRO
  // dele no início (quem já estava fora não "sai") — por isso muda com o raio.
  const comTrilha = linhas.filter(l => AVALIAVEIS.has(l.status));
  const gradeDe = (base) => GRADE_RAIOS.map(raioM => {
    const eleg = base.filter(l => l.pts[0].d <= raioM);
    return {
      raioM, elegiveis: eleg.length,
      porMin: GRADE_MIN.map(minForaMin => {
        const n = eleg.filter(l => S.saidasDoRaio(l.pts, l.janela, { raioM, minForaMin }).length > 0).length;
        return { minForaMin, n, pct: eleg.length ? Math.round((n / eleg.length) * 1000) / 10 : 0 };
      }),
    };
  });
  const prefixos = [...new Set(comTrilha.map(l => l.equipe.slice(0, 2)))]
    .map(p => [p, comTrilha.filter(l => l.equipe.startsWith(p))])
    .filter(([, ls]) => ls.length >= 50)
    .sort((a, b) => b[1].length - a[1].length);
  const grade = gradeDe(comTrilha);
  const gradePorPrefixo = prefixos.map(([p, ls]) => ({ prefixo: p, grade: gradeDe(ls) }));

  const foraIni = linhas.filter(l => l.status === 'fora_no_inicio');

  const pcts = (vals) => [50, 75, 90, 95, 99].map(p => [p, S.percentil(vals, p)]);
  const porTipo = new Map();
  for (const l of aval) {
    const k = l.tipo || '?';
    if (!porTipo.has(k)) porTipo.set(k, { tipo: k, avaliadas: 0, saiu: 0, dist: [] });
    const g = porTipo.get(k);
    g.avaliadas++; if (l.status === 'saiu') g.saiu++; g.dist.push(l.distMaxM);
  }
  const porEquipe = new Map();
  for (const l of aval) {
    if (!porEquipe.has(l.equipe)) porEquipe.set(l.equipe, { equipe: l.equipe, avaliadas: 0, saiu: 0, minFora: 0 });
    const g = porEquipe.get(l.equipe);
    g.avaliadas++; if (l.status === 'saiu') { g.saiu++; g.minFora += l.minFora; }
  }

  // Veículo divergente, agrupado por placa: é lista de conferência de cadastro.
  const divPorPlaca = new Map();
  for (const l of linhas.filter(x => x.status === 'veiculo_divergente')) {
    const k = `${l.placa} ${l.equipe}`;
    if (!divPorPlaca.has(k)) divPorPlaca.set(k, { placa: l.placa, equipe: l.equipe, notas: 0, dist: [], unidades: l.unidades });
    const g = divPorPlaca.get(k); g.notas++; g.dist.push(l.dVeiculoM);
  }
  // Placas sem NENHUM ponto do rastreador — casamento placa × rastreador.
  const semPlacaPorPlaca = new Map();
  for (const l of linhas.filter(x => x.status === 'sem_trilha_placa')) {
    const k = `${l.placa} ${l.equipe}`;
    if (!semPlacaPorPlaca.has(k)) semPlacaPorPlaca.set(k, { placa: l.placa, equipe: l.equipe, notas: 0 });
    semPlacaPorPlaca.get(k).notas++;
  }
  const semJanela = linhas.filter(x => x.status === 'sem_trilha_janela');

  return {
    gradePorPrefixo,
    foraNoInicio: {
      n: foraIni.length,
      dVeiculo: pcts(foraIni.map(l => l.pts[0].d)),
      dTablet: pcts(foraIni.map(l => l.dCadInicio).filter(v => v !== undefined)),
      casos: foraIni.slice().sort((a, b) => b.pts[0].d - a.pts[0].d).slice(0, 10),
    },
    divergentes: [...divPorPlaca.values()].map(g => ({ ...g, p50: S.percentil(g.dist, 50) }))
      .sort((a, b) => b.notas - a.notas),
    dVeiculoAval: pcts(aval.map(l => l.dVeiculoM).filter(v => v !== undefined)),
    semPlaca: [...semPlacaPorPlaca.values()].sort((a, b) => b.notas - a.notas),
    duracaoSemJanela: pcts(semJanela.map(l => l.duracaoMin)),
    duracaoAval: pcts(aval.map(l => l.duracaoMin)),
    buracoSemJanela: pcts(semJanela.map(l => l.buracoMin)),
    total: linhas.length,
    funil,
    avaliadas: aval.length,
    saiu: aval.filter(l => l.status === 'saiu').length,
    fonteAncora: contar(aval, l => l.ancora.fonte),
    fontePlaca: contar(aval, l => l.fontePlaca),
    pctDistMax: pcts(aval.map(l => l.distMaxM)),
    pctCadInicio: pcts(aval.map(l => l.dCadInicio).filter(v => v !== undefined)),
    pctAncoraVeiculo: pcts(aval.map(l => l.dAncoraVeiculoInicio).filter(v => v !== undefined)),
    pctBuraco: pcts(aval.map(l => l.buracoMin)),
    grade,
    // Prefixo da sigla (EP/EC/ET/EB…): plantão e comercial têm rotina diferente —
    // plantão patrulha rede atrás de defeito, e isso é deslocamento legítimo.
    porPrefixo: [...linhas.reduce((m, l) => {
      const k = l.equipe.slice(0, 2);
      if (!m.has(k)) m.set(k, { prefixo: k, total: 0, avaliadas: 0, saiu: 0 });
      const g = m.get(k); g.total++;
      if (l.status === 'ok' || l.status === 'saiu') g.avaliadas++;
      if (l.status === 'saiu') g.saiu++;
      return m;
    }, new Map()).values()].sort((a, b) => b.total - a.total),
    porTipo: [...porTipo.values()].map(g => ({ ...g, p90: S.percentil(g.dist, 90) }))
      .sort((a, b) => b.avaliadas - a.avaliadas),
    porEquipe: [...porEquipe.values()].filter(g => g.saiu > 0)
      .sort((a, b) => b.saiu - a.saiu || b.minFora - a.minFora),
    piores: aval.filter(l => l.status === 'saiu')
      .sort((a, b) => b.minFora * b.distMaxM - a.minFora * a.distMaxM).slice(0, args.top),
  };
}

function contar(arr, fn) {
  const o = {};
  for (const x of arr) { const k = fn(x); o[k] = (o[k] || 0) + 1; }
  return o;
}

function imprimir(res, { args, dias }, escrever) {
  const linha = '─'.repeat(90);
  const pct = (n, d) => d ? `${Math.round((n / d) * 1000) / 10}%` : '—';
  const fmtPcts = (arr, fmt = fmtM) => arr.map(([p, v]) => `p${p} ${fmt(v)}`).join('   ');

  escrever(`\nBACKTEST — deslocamento dentro da nota   (SOMENTE LEITURA)`);
  escrever(linha);
  escrever(`Período: ${dias[0]} → ${dias[dias.length - 1]} (${dias.length} dias)`);
  escrever(`Regra:   saiu = começou dentro e ficou ≥ ${args.minFora} min a mais de ${args.raio} m da âncora (≥ 2 pontos fora,`);
  escrever(`         ou 1 com ignição ligada),`);
  escrever(`         entre o Início do Trabalho (ev 2) e o Fim do Trabalho (ev 3). Âncora: ${args.ancora} primeiro.`);
  escrever(`         Veículo a mais de ${fmtM(args.limiteVeiculo)} do tablet no início = veiculo_divergente (fora da conta).`);
  escrever(`         Trilha só grava mudança: o último ponto antes do início vale como posição (até ${S.MAX_IDADE_ANTERIOR_MIN / 60}h).`);
  escrever(`         Frota inteira sem ponto por > ${args.maxBuracoFrota} min na execução = rastreador_fora (fora da conta).`);
  escrever(`         Placa: gseq Equipes × Veículos → sessão do WPA → equipes_oficiais.`);
  escrever(`         Patrulha (fora da conta): ${args.patrulha.length ? args.patrulha.map(p => p.join(' em ')).join(', ') : 'nenhuma'}.`);

  escrever(`\nFUNIL (notas concluídas de equipes oficiais, sem repetição entre dias: ${res.total})`);
  const ordem = ['ok', 'saiu', 'fora_no_inicio', 'patrulha', 'veiculo_divergente', 'rastreador_fora', 'sem_trilha_janela', 'sem_trilha_placa', 'sem_placa',
    'sem_ancora', 'sem_inicio', 'sem_fim', 'janela_invalida', 'sem_checkpoint', 'sem_detalhe'];
  for (const k of ordem.concat(Object.keys(res.funil).filter(k => !ordem.includes(k)))) {
    if (res.funil[k]) escrever(`  ${k.padEnd(16)} ${String(res.funil[k]).padStart(6)}  ${pct(res.funil[k], res.total)}`);
  }
  escrever(`  → avaliadas: ${res.avaliadas}  (só ok + saiu entram no denominador)`);
  escrever(`  âncora: ${JSON.stringify(res.fonteAncora)}   placa: ${JSON.stringify(res.fontePlaca)}`);

  escrever(`\nRESULTADO com a regra acima: ${res.saiu} de ${res.avaliadas} notas saíram (${pct(res.saiu, res.avaliadas)})`);

  escrever(`\nDISTÂNCIA MÁXIMA da âncora durante a execução (avaliadas):`);
  escrever(`  ${fmtPcts(res.pctDistMax)}`);
  escrever(`QUALIDADE DA ÂNCORA:`);
  escrever(`  cadastro EDP × GPS do início:      ${fmtPcts(res.pctCadInicio)}`);
  escrever(`  âncora × veículo no início (±10min): ${fmtPcts(res.pctAncoraVeiculo)}`);
  const fMin = v => v === null ? '—' : `${v} min`;
  escrever(`  maior buraco sem ponto na janela:  ${fmtPcts(res.pctBuraco, fMin)}`);
  escrever(`  veículo × tablet no início (aval.): ${fmtPcts(res.dVeiculoAval)}`);

  escrever(`\nVEÍCULO DIVERGENTE — a placa do WPA leva a um veículo longe do tablet (conferir cadastro)`);
  if (res.divergentes.length === 0) escrever('  nenhum');
  for (const g of res.divergentes.slice(0, 20)) {
    escrever(`  ${g.placa.padEnd(8)} ${g.equipe.padEnd(10)} ${String(g.notas).padStart(3)} notas   distância mediana ${fmtM(g.p50).padStart(8)}`
      + `   unidades no rastreador com essa placa: ${g.unidades}`);
  }

  escrever(`\nSEM TRILHA`);
  escrever(`  placa sem nenhum ponto no rastreador no dia (top 20 — conferir placa × nome da unidade):`);
  if (res.semPlaca.length === 0) escrever('    nenhuma');
  for (const g of res.semPlaca.slice(0, 20)) escrever(`    ${g.placa.padEnd(8)} ${g.equipe.padEnd(10)} ${String(g.notas).padStart(4)} notas`);
  escrever(`  placa tem pontos no período, mas nenhum nas ${S.MAX_IDADE_ANTERIOR_MIN / 60}h antes do início nem durante:`);
  escrever(`    duração da execução: ${fmtPcts(res.duracaoSemJanela, fMin)}`);
  escrever(`    maior buraco:        ${fmtPcts(res.buracoSemJanela, fMin)}`);
  escrever(`  (duração das avaliadas, p/ comparar: ${fmtPcts(res.duracaoAval, fMin)})`);

  const imprimeGrade = (titulo, grade) => {
    escrever(`\n${titulo}`);
    escrever(`  ${'raio'.padEnd(8)}${'base'.padStart(7)}` + GRADE_MIN.map(m => `≥${m} min`.padStart(16)).join(''));
    for (const g of grade) {
      escrever(`  ${fmtM(g.raioM).padEnd(8)}${String(g.elegiveis).padStart(7)}`
        + g.porMin.map(c => `${c.pct}% (${c.n})`.padStart(16)).join(''));
    }
  };
  imprimeGrade('GRADE DE CALIBRAÇÃO — % que seriam marcadas (base = veículo dentro do raio no início)', res.grade);
  for (const g of res.gradePorPrefixo) imprimeGrade(`  … só equipes ${g.prefixo}`, g.grade);

  const fi = res.foraNoInicio;
  escrever(`\nFORA DO LOCAL JÁ NO INÍCIO (${fi.n} notas) — veículo a mais de ${fmtM(args.raio)} da nota ao começar o trabalho`);
  escrever(`  veículo × nota no início: ${fmtPcts(fi.dVeiculo)}`);
  escrever(`  tablet  × nota no início: ${fmtPcts(fi.dTablet)}`);
  escrever(`  (tablet perto e veículo longe = foram a pé/outro carro; os dois longe = apontou longe ou cadastro da nota errado)`);
  for (const l of fi.casos) {
    escrever(`  ${l.data} ${l.equipe.padEnd(9)} nota ${String(l.numero).padEnd(11)} ${String(l.tipo || '').padEnd(4)}`
      + ` ${fmtHora(l.janela.inicio)}→${fmtHora(l.janela.fim)}  veículo ${fmtM(l.pts[0].d).padStart(7)}`
      + `  tablet ${fmtM(l.dCadInicio).padStart(7)}  ${String(l.km).replace('.', ',')} km rodados (${l.placa})`);
  }

  escrever(`\nPOR PREFIXO DE EQUIPE (cobertura e resultado)`);
  for (const g of res.porPrefixo) {
    escrever(`  ${g.prefixo.padEnd(4)} notas ${String(g.total).padStart(5)}   avaliadas ${String(g.avaliadas).padStart(5)} (${pct(g.avaliadas, g.total)})`
      + `   saíram ${String(g.saiu).padStart(4)} (${pct(g.saiu, g.avaliadas)})`);
  }

  escrever(`\nPOR TIPO DE NOTA`);
  for (const t of res.porTipo) {
    escrever(`  ${String(t.tipo).padEnd(6)} avaliadas ${String(t.avaliadas).padStart(5)}   saíram ${String(t.saiu).padStart(4)} (${pct(t.saiu, t.avaliadas)})   dist p90 ${fmtM(t.p90)}`);
  }

  escrever(`\nEQUIPES COM SAÍDA (top 15)`);
  if (res.porEquipe.length === 0) escrever('  nenhuma');
  for (const e of res.porEquipe.slice(0, 15)) {
    escrever(`  ${e.equipe.padEnd(10)} ${String(e.saiu).padStart(3)} de ${String(e.avaliadas).padStart(3)} notas   ${e.minFora} min fora no total`);
  }

  escrever(`\nPIORES CASOS (min fora × distância) — conferir no mapa antes de concluir qualquer coisa`);
  for (const l of res.piores) {
    escrever(`  ${l.data} ${l.equipe.padEnd(9)} nota ${String(l.numero).padEnd(11)} ${String(l.tipo || '').padEnd(4)}`
      + ` ${fmtHora(l.janela.inicio)}→${fmtHora(l.janela.fim)}  fora ${String(l.minFora).padStart(3)} min`
      + `  máx ${fmtM(l.distMaxM).padStart(7)}  ${String(l.km).replace('.', ',')} km  (${l.placa}, ${l.ancora.fonte}, ${l.pontos} pts)`);
    escrever(`      âncora ${l.ancora.lat},${l.ancora.lon}   mais longe ${l.pontoMax.lat},${l.pontoMax.lon} às ${fmtHora(l.pontoMax.t)}`);
  }
  escrever(`\n${linha}\n`);
}

const CSV_COLS = ['data', 'equipe', 'regional', 'numero', 'tipo', 'status', 'inicio', 'fim', 'ancora_fonte',
  'ancora_lat', 'ancora_lon', 'placa', 'placa_fonte', 'pontos', 'buraco_min', 'dist_max_m', 'min_fora', 'km',
  'd_cadastro_inicio_m', 'd_ancora_veiculo_inicio_m', 'd_veiculo_tablet_m', 'duracao_min', 'unidades_rastreador',
  'status_antes_divergencia', 'buraco_frota_min'];

function linhaCsv(l) {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
  const v = [l.data, l.equipe, l.regional, l.numero, l.tipo, l.status,
    iso(l.janela && l.janela.inicio), iso(l.janela && l.janela.fim),
    l.ancora && l.ancora.fonte, l.ancora && l.ancora.lat, l.ancora && l.ancora.lon,
    l.placa, l.fontePlaca, l.pontos, l.buracoMin, l.distMaxM, l.minFora, l.km,
    l.dCadInicio, l.dAncoraVeiculoInicio, l.dVeiculoM, l.duracaoMin, l.unidades, l.statusOriginal, l.buracoFrotaMin];
  return v.map(x => (x === undefined || x === null) ? '' : `"${String(x).replace(/"/g, '""')}"`).join(';');
}

async function executar({ pool, poolGseq, args, hoje = dateBRT(), escrever = console.log }) {
  const dias = diasDoPeriodo(args, hoje);
  const { rows: eqs } = await pool.query(`
    SELECT upper(sigla) AS sigla, placa FROM public.equipes_oficiais WHERE ativo = true`);
  const oficiais = new Map(eqs.map(e => [e.sigla, e.placa]));

  let alocacoes = [];
  try {
    const { rows } = await poolGseq.query(`
      SELECT upper(sigla) AS sigla, placa, tipo, desde, ate FROM equipes_veiculos`);
    alocacoes = rows;
  } catch (err) {
    console.error(`[diag-saida-nota] equipes_veiculos do gseq indisponível (${err.message}) — placa só do WPA/cadastro`);
  }

  const brutas = [];
  for (const data of dias) {
    const t0 = Date.now();
    const doDia = await lerDia({ pool, poolGseq, data, oficiais, alocacoes, args });
    brutas.push(...doDia);
    const av = doDia.filter(l => l.status === 'ok' || l.status === 'saiu').length;
    console.error(`[diag-saida-nota] ${data}: ${doDia.length} notas, ${av} avaliadas (${Date.now() - t0} ms)`);
  }
  const linhas = deduplicar(brutas);
  console.error(`[diag-saida-nota] ${brutas.length - linhas.length} linhas repetidas entre dias removidas`);

  const res = resumir(linhas, args);
  imprimir(res, { args, dias }, escrever);

  if (args.csv) {
    const corpo = [CSV_COLS.join(';')].concat(linhas.map(linhaCsv)).join('\n');
    require('fs').writeFileSync(args.csv, '﻿' + corpo, 'utf8');
    escrever(`CSV: ${linhas.length} linhas em ${args.csv}`);
  }
  return res;
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  if (args.ajuda) { console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  if (args.erros.length) { console.error(args.erros.join('\n')); process.exit(2); }
  require('dotenv').config();
  const { _getPool } = require('../services/pgShim');
  const { Pool } = require('pg');
  const pool = _getPool();
  const poolGseq = new Pool(configGseq());
  try {
    await executar({ pool, poolGseq, args });
  } finally {
    try { await pool.end(); } catch (_) { /* já fechado */ }
    try { await poolGseq.end(); } catch (_) { /* já fechado */ }
  }
}

module.exports = { lerArgs, diasDoPeriodo, configGseq, ehPatrulha, placaGseqNaData, lerDia, deduplicar, resumir, executar, linhaCsv };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('ERRO:', err.message); process.exit(1); });
}
