/**
 * services/cobertura.js — radar de cobertura por dia (10/11/2026, P0-16)
 *
 * POR QUE EXISTE: de 20/10 a 09/11/2026 os dias foram fechados por backfill,
 * que só gravava a produção. Rejeições, detalhes de nota, intervalos, saída da
 * nota, carteira e notas devolvidas ficaram vazios por três semanas e ninguém
 * viu até o José abrir a aba Rejeições (10/11/2026) e achar as barras zeradas.
 * Pedido dele: "se as rejeições não vinham, claro que vamos ter mais coisas que
 * não vinham com o backfill e que fugiam do nosso radar".
 *
 * O que faz: para cada dia já fechado, compara a produção com o que deveria
 * existir junto dela. Só LÊ o banco — nenhuma chamada à EDP. Três saídas:
 *   - `scripts/diag-cobertura-derivados.js <de> [<ate>]` (tabela no terminal);
 *   - depois do fechamento das 05h: log `cobertura_buraco`, estado em
 *     `cobertura_radar` (app_settings) e 1 aviso no Teams se o D-1 fechou com
 *     buraco (services/cronService.js);
 *   - `/api/admin/health` devolve o último `cobertura_radar`.
 *
 * Regra 7: aqui não se corrige nem se estima nada. O radar só diz que falta.
 */

'use strict';

const { dateBRT } = require('./timeUtil');

const SETTING = 'cobertura_radar';

// Limiar de cada checagem. `buraco` = dá para recarregar (a ação está no
// RUNBOOK); `aviso` = não tem retroativo, só fica registrado.
const REGRAS = [
  { chave: 'rejeicoes', nivel: 'buraco',
    falta: (d) => d.rej_snapshot >= 10 && d.rej_gravadas < d.rej_snapshot * 0.8,
    texto: (d) => `rejeições: ${d.rej_gravadas} gravadas de ${d.rej_snapshot} no snapshot` },
  { chave: 'intervalos', nivel: 'buraco',
    falta: (d) => d.intervalos === 0,
    texto: () => 'intervalos de sessão: nenhum' },
  // 10/11/2026: linha existir não basta. Sem o detalhe da nota a avaliação sai
  // `sem_janela` — em 09/11/2026 eram 818 de 856, com a tabela "preenchida".
  { chave: 'saida_nota', nivel: 'buraco',
    falta: (d) => d.saida_nota === 0 || (d.saida_nota >= 20 && d.saida_sem_janela > d.saida_nota * 0.5),
    texto: (d) => (d.saida_nota === 0 ? 'saída da nota: nenhuma linha'
      : `saída da nota: ${d.saida_sem_janela} de ${d.saida_nota} sem avaliação (falta o detalhe da nota)`) },
  { chave: 'detalhes', nivel: 'buraco',
    falta: (d) => d.concluidas >= 20 && d.concluidas_com_detalhe < d.concluidas * 0.7,
    texto: (d) => `detalhes de nota: ${d.concluidas_com_detalhe} de ${d.concluidas} concluídas` },
  { chave: 'escala', nivel: 'buraco',
    falta: (d) => d.escala === 0,
    texto: () => 'escala do dia: nenhuma linha' },
  { chave: 'ao_vivo', nivel: 'aviso',
    falta: (d) => d.coletas_ao_vivo === 0,
    texto: () => 'nenhuma coleta ao vivo no dia (fechado só por backfill)' },
  { chave: 'carteira', nivel: 'aviso',
    falta: (d) => d.carteira === 0,
    texto: () => 'carteira: nenhuma linha (sem retroativo)' },
  { chave: 'notas_devolvidas', nivel: 'aviso',
    falta: (d) => d.notas_devolvidas === 0,
    texto: () => 'notas devolvidas: nenhuma linha (sem retroativo)' },
];

/**
 * Avalia 1 dia. Pura (teste). Dia sem produção não é avaliado: sem operação
 * não há o que cobrar das tabelas derivadas.
 * @returns {{dia:string, producao:number, buracos:string[], avisos:string[], chaves:string[]}}
 */
function avaliarDia(d) {
  const out = { dia: d.dia, producao: d.producao, buracos: [], avisos: [], chaves: [] };
  if (!(d.producao > 0)) return out;
  for (const r of REGRAS) {
    if (!r.falta(d)) continue;
    out.chaves.push(r.chave);
    (r.nivel === 'buraco' ? out.buracos : out.avisos).push(r.texto(d));
  }
  return out;
}

/** Dias fechados do período, do mais antigo ao mais novo. Pura. */
function diasFechados(de, ate, hoje = dateBRT()) {
  const out = [];
  for (let t = Date.parse(`${de}T12:00:00Z`); t <= Date.parse(`${ate}T12:00:00Z`); t += 86400000) {
    const dia = new Date(t).toISOString().slice(0, 10);
    if (dia < hoje) out.push(dia);
  }
  return out;
}

// Uma consulta por dia, em série: o jsonb dos snapshots é pesado (P2-46).
// `data ? 'isOnline'` separa o snapshot ao vivo do de backfill (getTeamsByDate
// não devolve esse campo). Ids são comparados como uuid para usar os índices.
const SQL_DIA = `
  WITH u AS (
    SELECT DISTINCT ON (team_name) team_name, data
      FROM snapshots WHERE date = $1::date
     ORDER BY team_name, captured_at DESC
  ), rej AS (
    SELECT DISTINCT (n->>'id')::uuid AS id
      FROM u, jsonb_array_elements(COALESCE(u.data->'notasRejeitadas', '[]'::jsonb)) n
     WHERE n->>'id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ), con AS (
    SELECT DISTINCT (n->>'id')::uuid AS id
      FROM u, jsonb_array_elements(COALESCE(u.data->'notasConcluidas', '[]'::jsonb)) n
     WHERE n->>'id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
  SELECT
    (SELECT count(*) FROM u)::int AS equipes,
    (SELECT count(DISTINCT captured_at) FROM snapshots WHERE date = $1::date AND data ? 'isOnline')::int AS coletas_ao_vivo,
    (SELECT COALESCE(sum(count), 0) FROM team_daily_totals WHERE date = $1::date)::int AS producao,
    (SELECT count(*) FROM rej)::int AS rej_snapshot,
    (SELECT count(*) FROM rej r WHERE EXISTS (SELECT 1 FROM note_rejections x WHERE x.note_id = r.id))::int AS rej_gravadas,
    (SELECT count(*) FROM con)::int AS concluidas,
    (SELECT count(*) FROM con c WHERE EXISTS (SELECT 1 FROM note_details d WHERE d.note_id = c.id))::int AS concluidas_com_detalhe,
    (SELECT count(*) FROM sessao_intervalo WHERE data = $1::date)::int AS intervalos,
    (SELECT count(*) FROM saida_nota WHERE data = $1::date)::int AS saida_nota,
    (SELECT count(*) FROM saida_nota WHERE data = $1::date AND status = 'sem_janela')::int AS saida_sem_janela,
    (SELECT count(*) FROM team_daily_carteira WHERE date = $1::date)::int AS carteira,
    (SELECT count(*) FROM notas_daily_agg WHERE data = $1::date)::int AS notas_devolvidas,
    (SELECT count(*) FROM escala_dia WHERE data = $1::date)::int AS escala,
    (SELECT count(*) FROM note_interrupcoes WHERE dia = $1::date)::int AS interrupcoes`;

/** Mede os dias fechados de [de, ate]. Só leitura. */
async function medir(pool, de, ate, { hoje = dateBRT() } = {}) {
  const out = [];
  for (const dia of diasFechados(de, ate, hoje)) {
    const { rows } = await pool.query(SQL_DIA, [dia]);
    out.push({ dia, ...rows[0] });
  }
  return out;
}

/**
 * Resumo do radar para log, app_settings e /admin/health. Pura (teste).
 * Guarda só os dias com alguma falta — dia limpo não ocupa espaço.
 */
function resumir(medidos, { agora = Date.now() } = {}) {
  const dias = medidos.map(avaliarDia);
  const comFalta = dias.filter(d => d.buracos.length || d.avisos.length);
  return {
    ts: new Date(agora).toISOString(),
    de: medidos.length ? medidos[0].dia : null,
    ate: medidos.length ? medidos[medidos.length - 1].dia : null,
    dias_medidos: medidos.length,
    dias_com_buraco: dias.filter(d => d.buracos.length).map(d => d.dia),
    dias: comFalta.map(d => ({ dia: d.dia, producao: d.producao, buracos: d.buracos, avisos: d.avisos })),
  };
}

module.exports = { SETTING, REGRAS, avaliarDia, diasFechados, medir, resumir, SQL_DIA };
