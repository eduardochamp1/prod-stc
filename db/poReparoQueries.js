/**
 * db/poReparoQueries.js
 *
 * Fase 1 de docs/handoff/SPEC-tma-po-reparo-2026-08-30.md.
 *
 * Nas notas **PO**, a distância entre o **"Horário do Reparo"** apontado pela
 * equipe e o checkpoint **"Finalizando Trabalho"**. Critério da operação: no
 * mínimo **10 minutos**. Abaixo disso indica problema no método de apontamento —
 * e esses minutos entram no CHI do CSD atendido.
 *
 * ⚠️ NÃO confundir com o TMA regulatório (emissão → conclusão). A sub-aba se
 * chama "TMA (PO)" por decisão do José, mas mede outra coisa; a spec cancelada
 * do TMA de verdade é SPEC-subaba-tma-2026-08-29-CANCELADA.md.
 *
 * ── AS DUAS PONTAS ──────────────────────────────────────────────────────────
 *   Horário do Reparo    → /api/notes/po → PowerOnExecution.RepairTime
 *                          UTC, com "+00:00" explícito
 *   Finalizando Trabalho → checkpoint com Event === 4, campo RegisteredAt2
 *                          local, com "-03:00" explícito
 *
 * ⚠️⚠️ A ARMADILHA DESTE ARQUIVO É O FUSO. Medido com os valores reais da nota
 * 104875481 (RepairTime 20:18:45+00:00, evento 4 às 17:25:47-03:00):
 *
 *   TZ=America/Sao_Paulo   RegisteredAt2 → +7,03 min   RegisteredAt → +7,03 min
 *   TZ=UTC   (a VM)        RegisteredAt2 → +7,03 min   RegisteredAt → −172,97 min
 *
 * Usar `RegisteredAt` (sem o 2) FUNCIONA na máquina do dev e QUEBRA em produção,
 * com 3h de erro que ainda inverte o sinal — viraria "reparo 3h depois do fim do
 * trabalho", absurdo plausível o bastante pra passar por anomalia de campo em vez
 * de bug. Por isso aqui só entra `registradoEm` (que é o RegisteredAt2), e nota
 * sem ele NÃO É MEDIDA — nunca estimada.
 */

const { _getPool } = require('../services/pgShim');

/** Código de evento do checkpoint "Finalizando Trabalho" (conferido no portal). */
const EVENT_FINALIZANDO = 4;

/** Critério da operação, em segundos. */
const MINIMO_SEG = 10 * 60;

/**
 * FUNÇÃO PURA (testável): instante do "Finalizando Trabalho".
 *
 * Só aceita `registradoEm` (RegisteredAt2). Checkpoint sem ele é ignorado — ver
 * a nota de fuso no topo do arquivo.
 *
 * Várias tentativas geram vários event=4; vale o ÚLTIMO, que é o que fecha a
 * execução que terminou na conclusão da nota.
 *
 * @param {Array<{event:number, registradoEm:string}>} checkpoints
 * @returns {string|null} ISO, ou null se não der pra medir
 */
function finalizandoTrabalhoEm(checkpoints) {
  if (!Array.isArray(checkpoints)) return null;
  const instantes = checkpoints
    .filter(cp => cp && Number(cp.event) === EVENT_FINALIZANDO && cp.registradoEm)
    .map(cp => new Date(cp.registradoEm).getTime())
    .filter(n => Number.isFinite(n));
  if (instantes.length === 0) return null;
  return new Date(Math.max(...instantes)).toISOString();
}

/**
 * FUNÇÃO PURA (testável): monta a linha de `note_po_reparo`.
 *
 * `delta_seg` fica NULL quando falta qualquer uma das pontas. Não zera, não
 * estima: "não medido" e "medido em zero" são coisas diferentes, e a tela conta
 * as duas separado (a cobertura vive disso).
 *
 * Delta NEGATIVO é preservado de propósito — reparo apontado DEPOIS do fim do
 * trabalho é fisicamente impossível e é justamente o caso mais acionável. Foram
 * 6 em 158 na amostra de 30/08/2026, chegando a −42 minutos.
 *
 * @param {object} poExec       saída de wpaService.getNotePoExecution
 * @param {Array}  checkpoints  checkpoints JÁ PROCESSADOS (com `registradoEm`)
 */
function montarLinhaReparo(poExec, checkpoints) {
  const finalizando = finalizandoTrabalhoEm(checkpoints);
  const po = poExec || {};

  const tReparo = po.repairTime ? new Date(po.repairTime).getTime() : NaN;
  const tFim    = finalizando   ? new Date(finalizando).getTime()   : NaN;
  const mensuravel = Number.isFinite(tReparo) && Number.isFinite(tFim);

  return {
    repair_time:       po.repairTime || null,
    has_repair:        po.hasRepair === undefined ? null : po.hasRepair,
    finalizando_em:    finalizando,
    delta_seg:         mensuravel ? Math.round((tFim - tReparo) / 1000) : null,
    prediction_repair: po.predictionRepair || null,
    confirmation_date: po.confirmationDate || null,
    classe:            po.classe || null,
    causa:             po.causa  || null,
    clima:             po.clima  || null,
    team_id:           po.teamId || null,
  };
}

/** Classifica um delta em segundos. Fronteiras conferem com as faixas da tela. */
function faixaDoDelta(deltaSeg) {
  if (deltaSeg == null || !Number.isFinite(deltaSeg)) return 'nao_medido';
  if (deltaSeg < 0) return 'negativo';
  if (deltaSeg < MINIMO_SEG) return 'abaixo';
  return 'ok';
}

/**
 * Grava (ou atualiza) a linha da nota. Idempotente por `note_id`: o cron pode
 * reprocessar a mesma nota sem duplicar, como todo upsert deste projeto.
 */
async function upsertPoReparo(noteId, { numero, sector_id }, linha) {
  if (!noteId) return;
  const pool = _getPool();
  await pool.query(
    `INSERT INTO public.note_po_reparo
       (note_id, numero, sector_id, team_id, repair_time, has_repair,
        finalizando_em, delta_seg, prediction_repair, confirmation_date,
        classe, causa, clima, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (note_id) DO UPDATE SET
       numero            = EXCLUDED.numero,
       sector_id         = EXCLUDED.sector_id,
       team_id           = EXCLUDED.team_id,
       repair_time       = EXCLUDED.repair_time,
       has_repair        = EXCLUDED.has_repair,
       finalizando_em    = EXCLUDED.finalizando_em,
       delta_seg         = EXCLUDED.delta_seg,
       prediction_repair = EXCLUDED.prediction_repair,
       confirmation_date = EXCLUDED.confirmation_date,
       classe            = EXCLUDED.classe,
       causa             = EXCLUDED.causa,
       clima             = EXCLUDED.clima,
       atualizado_em     = now()`,
    [noteId, numero || null, sector_id || null, linha.team_id,
     linha.repair_time, linha.has_repair, linha.finalizando_em, linha.delta_seg,
     linha.prediction_repair, linha.confirmation_date,
     linha.classe, linha.causa, linha.clima],
  );
}

module.exports = {
  upsertPoReparo,
  // Puras, exportadas pra teste — é onde mora a regra que pode errar 3 horas.
  finalizandoTrabalhoEm,
  montarLinhaReparo,
  faixaDoDelta,
  EVENT_FINALIZANDO,
  MINIMO_SEG,
};
