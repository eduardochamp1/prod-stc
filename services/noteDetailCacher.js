/**
 * services/noteDetailCacher.js
 *
 * O trabalho de cachear UMA nota em `note_details`: busca o payload no WPA,
 * resolve a subcategoria, processa sem fotos, grava — e, se for PO, grava
 * também a linha de reparo.
 *
 * ── POR QUE ISTO É UM MÓDULO ────────────────────────────────────────────────
 * Isto vivia dentro de `runCacheNotaDetails` no cron. Em 09/09/2026 precisamos
 * do MESMO trabalho num backfill retroativo (`scripts/backfill-note-details.js`)
 * e a alternativa era copiar o laço. Foi exatamente esse caminho que produziu o
 * P1-47: `runSyncLogoffs` e `recuperar-logoffs.js` faziam "a mesma coisa" de
 * dois jeitos e divergiram em silêncio por semanas — 113 logoffs perdidos. Uma
 * implementação só, os dois chamam.
 *
 * ⚠️ O CRON É O DONO DO RITMO. Este módulo não decide quantas notas processar
 * nem quando parar: quem chama passa o lote já cortado. O cron corta em
 * MAX_CACHE_POR_CICLO pra caber na janela dele; o backfill corta pelo `--limite`.
 */

'use strict';

const log = require('./logger').forModule('note-cache');

/** Concorrência padrão. 4 é o que o cron usa desde sempre — não satura
 *  `/details/optimized` e não compete com o resto do ciclo de snapshot. */
const CONCORRENCIA_PADRAO = 4;

/**
 * Cacheia uma nota. Nunca lança: devolve `{ ok, id, reason? }`.
 *
 * `c` = { id, numero, tipo, sectorId }.
 */
async function cachearNota(c) {
  const sq = require('../db/queries');
  const { getNoteDetail, getNotePoExecution } = require('./wpaService');
  const { processarNota, classificarSubCategoria } = require('./notaProcessor');
  const { getSubcategoriasByIds } = require('../db/subcategoriasQueries');
  const { montarLinhaReparo, upsertPoReparo, dicionarioEquipes } = require('../db/poReparoQueries');

  try {
    const raw = await getNoteDetail(c.id, c.sectorId);
    if (!raw) return { ok: false, id: c.id, reason: 'WPA payload vazio' };

    // Resolve subcategoria
    let subcat = { subCategoria: null, subcatCode: null, quantidade: null };
    try {
      const cls = await getSubcategoriasByIds([raw.Id]);
      const ce = cls[raw.Id];
      if (ce) subcat = { subCategoria: ce.sub_categoria, subcatCode: ce.sub_code, quantidade: ce.quantidade };
    } catch {}
    if (!subcat.subCategoria) {
      // GroupDescription pode vir em raw.GroupDescription ou raw.Group?.Description
      // dependendo do endpoint. Passamos para alinhar com classifierService DD fallback.
      const groupDesc = raw.GroupDescription || raw.Group?.Description || '';
      const fb = classificarSubCategoria(raw.Type, raw.Code, raw.Comments, raw.Activities, groupDesc, raw.Address);
      subcat = { subCategoria: fb.subCategoria, subcatCode: fb.subcatCode, quantidade: fb.quantidade };
    }

    const processed = processarNota(raw, { incluirFotos: false, subcat });
    await sq.setNoteDetailCache(raw.Id, raw.Number, raw.Type, c.sectorId, processed);

    // 30/08/2026 — nota PO ganha uma 2ª chamada, pro "Horário do Reparo".
    // Ele NÃO existe no details/optimized (123 chaves, nenhuma de reparo);
    // a única fonte é /api/notes/po. Só PO: ~91 notas/dia, custo baixo.
    // Ver SPEC-tma-po-reparo-2026-08-30.md.
    //
    // O try/catch é obrigatório: o payload acima é a fonte de verdade e já
    // está gravado. Se a execução PO falhar, a nota NÃO pode ser marcada
    // como falha — o backfill (migrar-po-reparo.js) pega depois, porque a
    // retomada dele é por ausência de linha.
    if (raw.Type === 'PO') {
      try {
        const poExec = await getNotePoExecution(raw.Id);
        const linha  = montarLinhaReparo(poExec, processed.checkpoints);
        // A sigla da equipe é CONSOLIDADA aqui, junto com o resto. A EDP só
        // manda o UUID; resolver isso na leitura obrigava a expandir os
        // snapshots a cada consulta (~25s). Equipe ainda não conhecida fica
        // null e o backfill preenche depois — nunca apaga o que já existe.
        const dic = await dicionarioEquipes();
        const eq  = linha.team_id ? dic.get(String(linha.team_id)) : null;
        if (eq) { linha.team_name = eq.team_name; linha.regional = eq.regional; }
        await upsertPoReparo(raw.Id, { numero: raw.Number, sector_id: c.sectorId }, linha);
      } catch (errPo) {
        log.warn('po_reparo_falhou', { note: raw.Number, msg: errPo.message });
      }
    }
    return { ok: true, id: c.id, tipo: raw.Type, checkpoints: (processed.checkpoints || []).length };
  } catch (err) {
    return { ok: false, id: c.id, reason: err.message };
  }
}

/**
 * Cacheia um lote em chunks de `concorrencia`. Devolve `{ ok, falha, semCp, erros }`.
 *
 * `semCp` conta as notas gravadas cujo payload NÃO trouxe checkpoint nenhum —
 * é o número que diz se a lacuna de cobertura das regras de HE é de coleta
 * (resolve com backfill) ou do dado (não resolve com nada).
 */
async function cachearLote(lote, opts = {}) {
  const conc = Math.max(1, Number(opts.concorrencia) || CONCORRENCIA_PADRAO);
  // `opts.fn` existe pra TESTE: a contagem (ok/falha/semCp) e o que o backfill
  // usa pra decidir se a lacuna e de coleta ou do dado, e testar isso nao pode
  // depender de rede nem de banco.
  const fn = typeof opts.fn === 'function' ? opts.fn : cachearNota;
  const onProgresso = typeof opts.onProgresso === 'function' ? opts.onProgresso : null;

  let ok = 0, falha = 0, semCp = 0;
  const erros = [];

  for (let i = 0; i < lote.length; i += conc) {
    const chunk = lote.slice(i, i + conc);
    const results = await Promise.all(chunk.map(fn));
    for (const r of results) {
      if (r.ok) { ok++; if (!r.checkpoints) semCp++; }
      else { falha++; if (erros.length < 20) erros.push(`${r.id}: ${r.reason}`); }
    }
    if (onProgresso) onProgresso({ feitos: Math.min(i + conc, lote.length), total: lote.length, ok, falha, semCp });
    if (opts.pausaMs) await new Promise(r => setTimeout(r, opts.pausaMs));
  }

  return { ok, falha, semCp, erros };
}

module.exports = { cachearNota, cachearLote, CONCORRENCIA_PADRAO };
