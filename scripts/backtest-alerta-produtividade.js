#!/usr/bin/env node
/**
 * scripts/backtest-alerta-produtividade.js — SOMENTE LEITURA.
 *
 * Reaplica a regra do alerta de baixa produtividade sobre os últimos N dias de
 * snapshots e diz quantas equipes teriam alertado por dia e por categoria. É o
 * passo 4 do deploy (PLAN T10): o José lê isto ANTES de ligar `ativo:true`.
 *
 * A simulação usa a MESMA `avaliarEquipe` do alerta real, ciclo a ciclo (15 min),
 * a partir do meio do turno — ver services/alertaBacktest.js (e os LIMITES
 * CONHECIDOS no cabeçalho dele, que este script também imprime).
 *
 * USO (na VM):
 *   node scripts/backtest-alerta-produtividade.js                  # 30 dias, limite 4
 *   node scripts/backtest-alerta-produtividade.js --dias=14
 *   node scripts/backtest-alerta-produtividade.js --limite=3       # e se fosse 3?
 *   node scripts/backtest-alerta-produtividade.js --categorias=COMERCIAL,MOTO
 *   node scripts/backtest-alerta-produtividade.js --sem-refeicao   # ignora o adiamento
 *
 * Não grava nada. Um dia por vez (o jsonb dos snapshots é pesado: a VM tem ~3,8 GB
 * e P2-46 mediu 27 s só expandindo o jsonb) — nunca rode duas cópias em paralelo.
 */

'use strict';

const { validarConfig, DEFAULT_CONFIG } = require('../services/alertaProdutividade');
const B = require('../services/alertaBacktest');
const { categoriaDaSigla } = require('../services/categoriasEquipe');
const { dateBRT, dateBRTMinusDays } = require('../services/timeUtil');

/** Lê `--chave=valor` e `--flag`. Pura. */
function lerArgs(argv) {
  const out = { dias: 30, limite: null, categorias: null, semRefeicao: false, erros: [] };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--dias=(\d+)$/))) out.dias = Number(m[1]);
    else if ((m = a.match(/^--limite=(\d+)$/))) out.limite = Number(m[1]);
    else if ((m = a.match(/^--categorias=(.+)$/))) out.categorias = m[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--sem-refeicao') out.semRefeicao = true;
    else if (a === '--help' || a === '-h') out.ajuda = true;
    else out.erros.push(`argumento desconhecido: ${a}`);
  }
  if (!Number.isInteger(out.dias) || out.dias < 1 || out.dias > 120) out.erros.push('--dias deve ser inteiro entre 1 e 120');
  return out;
}

const SQL_EQUIPES = `
  SELECT sigla, regional, escala_inicio::text AS escala_inicio, escala_fim::text AS escala_fim
    FROM public.equipes_oficiais WHERE ativo = true`;

// jsonb_path_query_array extrai SÓ os ids no servidor: o jsonb inteiro do snapshot
// carrega a carteira e as fotos e é pesado demais pra trazer pro Node.
const SQL_SNAPSHOTS = `
  SELECT team_name, captured_at, session_end,
         jsonb_path_query_array(data, '$.notasConcluidas[*].id') AS conc,
         jsonb_path_query_array(data, '$.notasRejeitadas[*].id') AS rej
    FROM public.snapshots
   WHERE date = $1::date`;

// AT TIME ZONE 'UTC' DESFAZ o 'Z' errado anexado na coleta (P1-48) e devolve a hora
// de PAREDE — a mesma técnica da Medição HE (heQueries.js:423-430).
const SQL_INTERVALOS = `
  SELECT upper(btrim(equipe)) AS equipe, motivo,
         to_char(inicio AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS inicio,
         to_char(fim    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS fim
    FROM public.sessao_intervalo
   WHERE data = $1::date AND motivo ILIKE '%refei%'`;

/**
 * Executa o backtest. `pool` e `escrever` são injetados (o teste usa um pool falso).
 * @returns {Promise<object>} o resumo (a mesma estrutura de alertaBacktest.resumir)
 */
async function executar({ pool, args, hoje = dateBRT(), escrever = console.log }) {
  const config = validarConfig({
    ativo: true,
    limite: args.limite === null ? DEFAULT_CONFIG.limite : args.limite,
    categorias: args.categorias || [...DEFAULT_CONFIG.categorias],
  });
  if (!config.ok) throw new Error('parâmetros inválidos: ' + config.erros.join('; '));
  const cfg = config.config;

  const { rows: eqs } = await pool.query(SQL_EQUIPES);
  const meta = new Map(eqs.map(e => [String(e.sigla).toUpperCase(), e]));

  let comRefeicao = !args.semRefeicao;
  let refeicaoIndisponivel = false;
  const resultados = [];
  const diasSemRefeicao = [];

  const dias = [];
  for (let i = args.dias; i >= 1; i--) dias.push(dateBRTMinusDays(i));   // hoje fica de fora (incompleto)

  for (const data of dias) {
    const { rows } = await pool.query(SQL_SNAPSHOTS, [data]);
    const snapsPorEquipe = B.montarSnapsPorEquipe(rows);
    if (snapsPorEquipe.size === 0) continue;

    let intervalosPorEquipe = new Map();
    if (comRefeicao) {
      try {
        const { rows: ints } = await pool.query(SQL_INTERVALOS, [data]);
        for (const r of ints) {
          if (!intervalosPorEquipe.has(r.equipe)) intervalosPorEquipe.set(r.equipe, []);
          intervalosPorEquipe.get(r.equipe).push({ motivo: r.motivo, inicio: r.inicio, fim: r.fim || null });
        }
        if (ints.length === 0) diasSemRefeicao.push(data);   // dia sem coleta, não "sem almoço"
      } catch (err) {
        // Tabela ausente / erro: segue SEM o adiamento e DIZ isso na saída.
        comRefeicao = false;
        refeicaoIndisponivel = err.message;
      }
    }

    for (const [equipe, snaps] of snapsPorEquipe) {
      const m = meta.get(String(equipe).toUpperCase());
      if (!m) continue;                                        // fora da whitelist
      const r = B.simularEquipeDia({
        data, categoria: categoriaDaSigla(equipe),
        escala: { inicio: m.escala_inicio, fim: m.escala_fim },
        config: cfg, comRefeicao,
        intervalos: intervalosPorEquipe.get(String(equipe).toUpperCase()) || [],
        snaps,
      });
      resultados.push({ ...r, data, equipe, categoria: categoriaDaSigla(equipe) });
    }
  }

  const resumo = B.resumir(resultados);
  imprimir(resumo, { cfg, args, dias, comRefeicao, refeicaoIndisponivel, diasSemRefeicao }, escrever);
  return resumo;
}

function imprimir(res, ctx, escrever) {
  const { cfg, args, dias } = ctx;
  const linha = '─'.repeat(78);
  escrever(`\nBACKTEST — alerta de baixa produtividade   (SOMENTE LEITURA)`);
  escrever(linha);
  escrever(`Período: ${dias[0]} → ${dias[dias.length - 1]} (${dias.length} dias; hoje fica de fora)`);
  escrever(`Regra:   < ${cfg.limite} executadas (não rejeitadas) a partir do meio do turno; ciclos de ${B.PASSO_CICLO_MIN} min`);
  escrever(`Categorias: ${cfg.categorias.join(', ')}`);
  if (ctx.comRefeicao) {
    escrever(`Refeição: ADIAMENTO considerado (sessao_intervalo, lida em hora de parede — P1-48)`);
    if (ctx.diasSemRefeicao.length) escrever(`  ⚠ ${ctx.diasSemRefeicao.length} dia(s) sem coleta de intervalos (almoço desconhecido): ${ctx.diasSemRefeicao.join(', ')}`);
  } else {
    escrever(`Refeição: NÃO considerada${ctx.refeicaoIndisponivel ? ` — sessao_intervalo indisponível (${ctx.refeicaoIndisponivel})` : ' (--sem-refeicao)'}.`);
    escrever(`  ⚠ Resultado é um TETO de alertas, não uma previsão exata: equipe almoçando conta como alerta.`);
  }
  escrever(`\nLimites conhecidos: escala = a ATUAL da equipe; executadas vem dos snapshots`);
  escrever(`  (sem o ajuste de _notaDate do team_daily_totals) → pode vir um pouco ALTA.`);
  escrever(linha);

  const cats = cfg.categorias;
  escrever(`\nPor dia — % de equipes avaliadas que alertariam (alertariam/avaliadas)\n`);
  escrever(['data      '].concat(cats.map(c => c.padEnd(16))).join(' ') + ' TOTAL');
  const porData = new Map();
  for (const x of res.porDiaCategoria) {
    if (!porData.has(x.data)) porData.set(x.data, {});
    porData.get(x.data)[x.categoria] = x;
  }
  for (const [data, g] of porData) {
    let a = 0, v = 0;
    const cols = cats.map(c => {
      const x = g[c];
      if (!x) return '—'.padEnd(16);
      a += x.alertariam; v += x.avaliadas;
      return `${x.pct}% (${x.alertariam}/${x.avaliadas})`.padEnd(16);
    });
    escrever([data].concat(cols).join(' ') + ` ${v ? Math.round((a / v) * 1000) / 10 : 0}% (${a}/${v})`);
  }

  const t = res.total;
  escrever(`\n${linha}\nRESUMO`);
  escrever(`  Equipe-dia avaliadas: ${t.avaliadas}   alertariam: ${t.alertariam} (${t.pct}%)`);
  escrever(`  Média diária de equipes que alertariam: ${res.mediaPctDiaria}%`);
  escrever(`  Dos que alertariam, chegaram ao limite depois (alerta resolvido): ${t.resolveramDepois} de ${t.alertariam}`);
  escrever(`  Executadas no meio do turno (todas as avaliadas): ` +
    Object.entries(res.distribuicao).map(([k, v]) => `${k}: ${v}`).join('   '));
  escrever(`\nIgnoradas (fora do denominador):`);
  const ig = Object.entries(res.ignoradas);
  if (ig.length === 0) escrever('  nenhuma');
  for (const [motivo, g] of ig) {
    const nomes = g.equipes.length > 8 ? g.equipes.slice(0, 8).join(', ') + `, … (+${g.equipes.length - 8})` : g.equipes.join(', ');
    escrever(`  ${motivo.padEnd(20)} ${String(g.ocorrencias).padStart(5)} ocorrência(s)   equipes: ${nomes}`);
  }
  escrever(`\nVEREDITO (ajuda a ler, não decide): ${B.veredito(t.avaliadas ? res.mediaPctDiaria : null)}`);
  escrever(`${linha}\n`);
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  if (args.ajuda) { console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  if (args.erros.length) { console.error(args.erros.join('\n')); process.exit(2); }
  require('dotenv').config();
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  try {
    await executar({ pool, args });
  } finally {
    try { await pool.end(); } catch (_) { /* já fechado */ }
  }
}

module.exports = { lerArgs, executar, SQL_EQUIPES, SQL_SNAPSHOTS, SQL_INTERVALOS };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('ERRO:', err.message); process.exit(1); });
}
