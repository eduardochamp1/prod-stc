#!/usr/bin/env node
/**
 * scripts/diag-sugere-placa.js — ESTRITAMENTE READ-ONLY.
 *
 * Sugere a placa que cada equipe está usando DE VERDADE, pelo rastreador.
 *
 * Por quê (18/10/2026): o backtest da saída da nota (diag-saida-nota.js) achou
 * ~20 equipes cuja placa da sessão do WPA leva a um veículo a 30–750 km do
 * tablet a semana inteira (ex.: ECCIT53/PXA2H80, ECPIU90/QNF4438), e o cadastro
 * Equipes × Veículos do gseq (`equipes_veiculos`) não tem linha para elas. Este
 * script entrega à operação a lista pronta para conferir e cadastrar.
 *
 * Como: para cada nota concluída, pega o GPS do TABLET no "Início do Trabalho"
 * (checkpoint 2) e procura quais veículos do rastreador estavam a até --raio
 * metros dali nesse instante (posição = último ponto até 6h antes; a trilha do
 * gseq só grava mudança, então silêncio = parado). Por equipe, conta em quantas
 * notas cada veículo estava junto. O que aparece em quase todas é o da equipe.
 *
 * USO (na VM, em ~/prod-stc):
 *   node scripts/diag-sugere-placa.js                        # 7 dias até ontem, só onde diverge
 *   node scripts/diag-sugere-placa.js --todas                # também as equipes que conferem
 *   node scripts/diag-sugere-placa.js --equipes=ECCIT53,ECPIU90 --dias=14
 *   node scripts/diag-sugere-placa.js --csv=/tmp/sugere-placa.csv
 *
 * Banco gseq: igual ao diag-saida-nota (socket local, ou GSEQ_DATABASE_URL).
 * Não grava nada. LGPD: o nome da unidade no rastreador às vezes traz o nome do
 * motorista — este script só usa e imprime a PLACA extraída dele.
 * ⚠️ É SUGESTÃO para conferência humana: o cadastro no gseq é feito por gente,
 * e base/pátio com vários veículos juntos pode enganar (por isso a força).
 */

'use strict';

const S = require('../services/saidaNota');
const { dateBRT } = require('../services/timeUtil');
const { diasDoPeriodo, configGseq, deduplicar } = require('./diag-saida-nota');
const { placaGseqNaData } = S;

const MIN_ANTES = 360;   // posição herdada vale até 6h antes do instante
const MIN_DEPOIS = 15;   // sem ponto antes, aceita o primeiro até 15 min depois

function lerArgs(argv) {
  const out = { dias: 7, ate: null, raio: 300, minNotas: 5, equipes: null, todas: false, csv: null, erros: [] };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--dias=(\d+)$/))) out.dias = Number(m[1]);
    else if ((m = a.match(/^--ate=(\d{4}-\d{2}-\d{2})$/))) out.ate = m[1];
    else if ((m = a.match(/^--raio=(\d+)$/))) out.raio = Number(m[1]);
    else if ((m = a.match(/^--min-notas=(\d+)$/))) out.minNotas = Number(m[1]);
    else if ((m = a.match(/^--equipes=(.+)$/))) out.equipes = m[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--todas') out.todas = true;
    else if ((m = a.match(/^--csv=(.+)$/))) out.csv = m[1];
    else if (a === '--help' || a === '-h') out.ajuda = true;
    else out.erros.push(`argumento desconhecido: ${a}`);
  }
  if (out.dias < 1 || out.dias > 60) out.erros.push('--dias deve ficar entre 1 e 60 (retenção do rastreador)');
  if (out.raio < 50) out.erros.push('--raio abaixo de 50 m é ruído de GPS');
  return out;
}

/** "TZW7G19" → "TZW-7G19" (o formato que o gseq guarda). */
const fmtPlaca = (p) => (p ? `${p.slice(0, 3)}-${p.slice(3)}` : '—');

// placaDoNome, posicaoNoInstante e veiculosPerto moram em services/saidaNota.js
// desde 19/10/2026 — a aba (P2-70) usa as mesmas para sugerir a placa.
const { placaDoNome, posicaoNoInstante, veiculosPerto } = S;

/**
 * Veredito de uma equipe. `contagem`: Map placa → nº de notas junto; `n`: notas
 * com GPS do tablet no início. Pura.
 *   forte  = ≥ minNotas, o 1º esteve junto em ≥ 60% e tem ≥ 2× o 2º;
 *   fraca  = há candidato, mas não passa no forte;
 *   nenhum = nenhum veículo do rastreador junto do tablet.
 */
function veredito(contagem, n, minNotas) {
  const rank = [...contagem.entries()].sort((a, b) => b[1] - a[1]);
  if (rank.length === 0) return { forca: 'nenhum', rank };
  const [, c1] = rank[0];
  const c2 = rank[1] ? rank[1][1] : 0;
  const forte = n >= minNotas && c1 / n >= 0.6 && c1 >= 2 * c2;
  return { forca: forte ? 'forte' : 'fraca', rank };
}

async function lerDia({ pool, data, oficiais, args }) {
  const { rows: notas } = await pool.query(`
    SELECT DISTINCT ON (n->>'id')
           n->>'id'                AS note_id,
           s.team_name,
           s.data->>'vehiclePlate' AS placa_wpa
      FROM public.snapshots s,
           LATERAL jsonb_array_elements(COALESCE(s.data->'notasConcluidas', '[]'::jsonb)) n
     WHERE s.date = $1::date
       AND n->>'id' IS NOT NULL
     ORDER BY n->>'id', s.captured_at DESC`, [data]);
  const doDia = notas.filter(n => {
    const eq = String(n.team_name).toUpperCase();
    return oficiais.has(eq) && (!args.equipes || args.equipes.includes(eq));
  });
  if (doDia.length === 0) return [];
  const { rows: det } = await pool.query(`
    SELECT note_id::text AS note_id, payload->'checkpoints' AS checkpoints
      FROM public.note_details
     WHERE note_id = ANY($1::uuid[])`, [doDia.map(n => n.note_id)]);
  const cps = new Map(det.map(d => [d.note_id, d.checkpoints]));
  const out = [];
  for (const n of doDia) {
    const janela = S.janelaExecucao(cps.get(n.note_id));
    if (janela.motivo || !janela.cpInicio) continue;
    out.push({ note_id: n.note_id, data, equipe: String(n.team_name).toUpperCase(),
      placaWpa: S.placaChave(n.placa_wpa), janela });
  }
  return out;
}

/** Frota inteira no intervalo: Map placa → pontos ordenados. */
async function lerFrota(poolGseq, ini, fim) {
  const { rows } = await poolGseq.query(`
    SELECT vehicle, lat, lon, COALESCE("eventAt", "recordedAt") AS t
      FROM vehicle_positions
     WHERE "recordedAt" >= $1 AND "recordedAt" < $2`,
    [new Date(ini), new Date(fim + 3 * 3600000)]);
  const frota = new Map();
  for (const r of rows) {
    const t = new Date(r.t).getTime();
    if (t < ini || t > fim) continue;
    const placa = placaDoNome(r.vehicle);
    if (!placa) continue;
    if (!frota.has(placa)) frota.set(placa, []);
    frota.get(placa).push({ t, lat: Number(r.lat), lon: Number(r.lon) });
  }
  for (const pts of frota.values()) pts.sort((a, b) => a.t - b.t);
  return frota;
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
    console.error(`[diag-sugere-placa] equipes_veiculos indisponível (${err.message})`);
  }

  const porEquipe = new Map();      // equipe → { n, contagem, wpa: Map placa→n, rastreadas }
  const placasNoRastreador = new Set();
  let brutas = [];
  for (const data of dias) {
    const t0 = Date.now();
    const notas = await lerDia({ pool, data, oficiais, args });
    brutas = brutas.concat(notas);
    console.error(`[diag-sugere-placa] ${data}: ${notas.length} notas com GPS do tablet no início (${Date.now() - t0} ms)`);
  }
  const notas = deduplicar(brutas);

  // Uma leitura de frota por dia de execução (o jsonb já foi; a frota é o peso aqui).
  const porDia = new Map();
  for (const n of notas) {
    const d = dateBRT(new Date(n.janela.inicio));
    if (!porDia.has(d)) porDia.set(d, []);
    porDia.get(d).push(n);
  }
  for (const [d, ns] of porDia) {
    const t0 = Date.now();
    const ini = Math.min(...ns.map(n => n.janela.inicio)) - MIN_ANTES * 60000;
    const fim = Math.max(...ns.map(n => n.janela.inicio)) + MIN_DEPOIS * 60000;
    const frota = await lerFrota(poolGseq, ini, fim);
    for (const p of frota.keys()) placasNoRastreador.add(p);
    for (const n of ns) {
      if (!porEquipe.has(n.equipe)) porEquipe.set(n.equipe, { n: 0, contagem: new Map(), wpa: new Map(), datas: [] });
      const g = porEquipe.get(n.equipe);
      g.n++;
      g.datas.push(n.data);
      if (n.placaWpa) g.wpa.set(n.placaWpa, (g.wpa.get(n.placaWpa) || 0) + 1);
      for (const pl of veiculosPerto(frota, n.janela.cpInicio, n.janela.inicio, args.raio)) {
        g.contagem.set(pl, (g.contagem.get(pl) || 0) + 1);
      }
    }
    console.error(`[diag-sugere-placa] frota de ${d}: ${frota.size} veículos com placa, ${ns.length} notas (${Date.now() - t0} ms)`);
  }

  const ultimoDia = dias[dias.length - 1];
  const linhas = [...porEquipe.entries()].map(([equipe, g]) => {
    const wpa = [...g.wpa.entries()].sort((a, b) => b[1] - a[1])[0];
    const placaWpa = wpa ? wpa[0] : null;
    const gseq = S.placaChave(placaGseqNaData(alocacoes, equipe, ultimoDia));
    const v = veredito(g.contagem, g.n, args.minNotas);
    const sugerida = v.rank[0] ? v.rank[0][0] : null;
    const atual = gseq || placaWpa;
    return {
      equipe, notas: g.n, placaWpa, placaGseq: gseq, wpaNoRastreador: placaWpa ? placasNoRastreador.has(placaWpa) : false,
      forca: v.forca, sugerida, rank: v.rank.slice(0, 3),
      confere: !!sugerida && sugerida === atual,
    };
  }).sort((a, b) => b.notas - a.notas);

  imprimir(linhas, { args, dias }, escrever);

  if (args.csv) {
    const cab = 'equipe;notas;placa_wpa;placa_gseq;wpa_no_rastreador;sugerida;forca;junto_1;junto_2;confere';
    const corpo = linhas.map(l => [l.equipe, l.notas, fmtPlaca(l.placaWpa), fmtPlaca(l.placaGseq),
      l.wpaNoRastreador ? 'sim' : 'nao', fmtPlaca(l.sugerida), l.forca,
      l.rank[0] ? l.rank[0][1] : 0, l.rank[1] ? l.rank[1][1] : 0, l.confere ? 'sim' : 'nao'].join(';'));
    require('fs').writeFileSync(args.csv, '﻿' + [cab].concat(corpo).join('\n'), 'utf8');
    escrever(`CSV: ${linhas.length} equipes em ${args.csv}`);
  }
  return linhas;
}

function imprimir(linhas, { args, dias }, escrever) {
  const linha = '─'.repeat(100);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  escrever(`\nSUGESTÃO DE PLACA PELO RASTREADOR   (SOMENTE LEITURA — conferir antes de cadastrar)`);
  escrever(linha);
  escrever(`Período: ${dias[0]} → ${dias[dias.length - 1]}   veículo "junto" = a até ${args.raio} m do tablet no Início do Trabalho`);
  escrever(`Força: forte = ≥ ${args.minNotas} notas, junto em ≥ 60% delas e ≥ 2× o 2º colocado.`);

  const confere = linhas.filter(l => l.confere);
  const diverge = linhas.filter(l => !l.confere && l.sugerida);
  const nenhum = linhas.filter(l => !l.sugerida);
  escrever(`\nResumo: ${linhas.length} equipes   conferem ${confere.length}   divergem ${diverge.length}`
    + ` (fortes ${diverge.filter(l => l.forca === 'forte').length})   sem veículo do rastreador junto ${nenhum.length}`);

  const cab = `  ${'equipe'.padEnd(10)}${'notas'.padStart(6)}  ${'placa WPA'.padEnd(10)}${'no rastr.'.padEnd(10)}`
    + `${'gseq'.padEnd(10)}→ ${'SUGERIDA'.padEnd(10)}${'força'.padEnd(7)}  junto (1º / 2º)`;
  const fmt = (l) => `  ${l.equipe.padEnd(10)}${String(l.notas).padStart(6)}  ${fmtPlaca(l.placaWpa).padEnd(10)}`
    + `${(l.placaWpa ? (l.wpaNoRastreador ? 'sim' : 'NÃO') : '—').padEnd(10)}${fmtPlaca(l.placaGseq).padEnd(10)}`
    + `→ ${fmtPlaca(l.sugerida).padEnd(10)}${l.forca.padEnd(7)}  `
    + l.rank.map(([p, c]) => `${fmtPlaca(p)} ${c} (${pct(c, l.notas)})`).join(' / ');

  escrever(`\nDIVERGEM — o veículo junto do tablet não é a placa atual (cadastrar no gseq: Veículos → Equipes × Veículos)`);
  escrever(cab);
  if (diverge.length === 0) escrever('  nenhuma');
  for (const l of diverge) escrever(fmt(l));

  escrever(`\nSEM VEÍCULO DO RASTREADOR JUNTO — provável veículo sem rastreador (ex.: ET)`);
  if (nenhum.length === 0) escrever('  nenhuma');
  for (const l of nenhum) {
    escrever(`  ${l.equipe.padEnd(10)}${String(l.notas).padStart(6)}  placa WPA ${fmtPlaca(l.placaWpa)}`
      + `  ${l.placaWpa ? (l.wpaNoRastreador ? '(está no rastreador)' : '(NÃO está no rastreador)') : ''}`);
  }

  if (args.todas) {
    escrever(`\nCONFEREM`);
    escrever(cab);
    for (const l of confere) escrever(fmt(l));
  }
  escrever(`\n${linha}\n`);
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

module.exports = { lerArgs, placaDoNome, fmtPlaca, posicaoNoInstante, veiculosPerto, veredito, executar };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('ERRO:', err.message); process.exit(1); });
}
