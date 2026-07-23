/**
 * services/bucketMath.js
 *
 * FONTE ÚNICA da aritmética de carteira por (equipe|regional) no dia (P2-2).
 *
 * Antes esta matemática estava DUPLICADA em dois lugares:
 *   - services/dataService.js  (_buildDiaSummary — visão "hoje" ao vivo)
 *   - services/dataWriter.js   (upsertTeamDailyCarteira — histórico persistido)
 * Mudar a regra num só lugar fazia o histórico divergir do ao-vivo — foi
 * exatamente a origem do bug de 11/06/2026 (canceladas 904 vs 294 esperado).
 * Agora os dois chamam `classifyBuckets`, então a regra é literalmente a mesma.
 *
 * REGRA (decisão de 20/07/2026, José): cada UUID cai em EXATAMENTE 1 bucket
 * final, por PRIORIDADE decrescente:
 *     rejeitada > concluída > andamento > atual
 * Uma nota concluída pela equipe MAS rejeitada pela EDP conta SÓ como rejeitada
 * — não é produção válida. O WPA mantém a nota nas duas listas; sem a
 * prioridade, a produtividade reportada à EDP inflaria (ECTSJ83: 17 executadas
 * sendo 14 rejeitadas). Precisa bater com _aggregateTeamDailyTotals e
 * detectDrift (dataWriter.js).
 *
 * INVARIANTE (verificável — travada em test/bucketMath.test.js):
 *     atual + andamento + concluidas + rejeitadas + canceladas
 *       = inicial + entradas_novas
 * (canceladas = UUIDs do início que sumiram; entradas_novas = UUIDs que
 *  apareceram depois do 1º snapshot). NÃO é `inicial = ... + entradas_novas`
 *  — um comentário antigo em dataService dizia isso e estava impreciso.
 */

'use strict';

/**
 * Classifica os UUIDs do dia em buckets e conta canceladas/entradas.
 *
 * @param {Object} sets  conjuntos de UUID (Set<string>):
 *   - inicial     UUIDs vistos no 1º snapshot do dia (todos os buckets juntos)
 *   - atual       "baixadas" no ÚLTIMO snapshot
 *   - andamento   "executadas" no último snapshot
 *   - concluidas  "concluídas" no último snapshot
 *   - rejeitadas  "rejeitadas" no último snapshot (o caller já uniu com
 *                 note_rejections persistente, que o WPA limpa do payload)
 * @returns {{inicial:number, atual:number, andamento:number, concluidas:number,
 *            rejeitadas:number, canceladas:number, entradas_novas:number}} contagens
 */
function classifyBuckets({ inicial, atual, andamento, concluidas, rejeitadas }) {
  // União dos 4 buckets do último snapshot = tudo que ainda está rastreado.
  const todas = new Set([...atual, ...andamento, ...concluidas, ...rejeitadas]);

  let cAtual = 0, cAndamento = 0, cConcluidas = 0, cRejeitadas = 0;
  for (const u of todas) {
    if      (rejeitadas.has(u)) cRejeitadas++;   // prioridade decrescente
    else if (concluidas.has(u)) cConcluidas++;
    else if (andamento.has(u))  cAndamento++;
    else                        cAtual++;
  }

  // Canceladas = estavam no início e sumiram do último snapshot.
  let canceladas = 0;
  for (const u of inicial) if (!todas.has(u)) canceladas++;

  // Entradas novas = apareceram depois do 1º snapshot (não estavam no início).
  let entradas = 0;
  for (const u of todas) if (!inicial.has(u)) entradas++;

  return {
    inicial: inicial.size,
    atual: cAtual,
    andamento: cAndamento,
    concluidas: cConcluidas,
    rejeitadas: cRejeitadas,
    canceladas,
    entradas_novas: entradas,
  };
}

module.exports = { classifyBuckets };
