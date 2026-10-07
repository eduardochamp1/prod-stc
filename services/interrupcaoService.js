/**
 * services/interrupcaoService.js
 *
 * Coleta das INTERRUPÇÕES de notas MD → tabela `note_interrupcoes`.
 *
 * ── O PEDIDO (José, 07/10/2026) ─────────────────────────────────────────────
 * Coluna de interrupções no grupo MD da matriz "Notas Atendidas por Tipo",
 * só para as subcategorias Subs Obsoleto e Subs TL11. Regras dele:
 *   - conta no DIA da interrupção, na EQUIPE que interrompeu;
 *   - interrupção NÃO é produção: fica fora da SOMA (EXEC + REJE) e do %REJ;
 *   - se a nota for concluída depois, conta também como EXEC (são eventos
 *     diferentes, não há bucket exclusivo aqui).
 * O filtro de subcategoria é feito na LEITURA (db/queries.js), não aqui: na hora
 * da coleta a nota pode ainda não estar classificada em note_subcategorias.
 *
 * ── DE ONDE VEM O DADO ──────────────────────────────────────────────────────
 * "Interrompida" NÃO é um status nosso: os snapshots só têm baixada / executada
 * / concluida / rejeitada. Investigado em 07/10/2026
 * (scripts/diag-nota-interrompida.js):
 *   - a nota interrompida 105293301 veio no teamsstatus/V2 em Downloaded com
 *     ExecutionStatus 3 — que o STATUS_V2 chama de "executada (em andamento)";
 *   - o Gestão Online do portal mostra "Interromp." na coluna Status de
 *     execução de notas da carteira;
 *   - GET /api/Notes/{id}/completeInterruptions traz o histórico: equipe
 *     (TeamName), data em BRT, motivo e observação — 1 linha por interrupção,
 *     com Id próprio.
 *
 * Então: o V2 que JÁ buscamos a cada ciclo aponta as MD em ExecutionStatus 3
 * (custo zero), e só para essas fazemos 1 GET no completeInterruptions.
 *
 * ⚠️ HIPÓTESE a confirmar: ExecutionStatus 3 = interrompida. Se estiver
 * errada, o efeito é SUBCONTAGEM (gatilho não dispara), nunca número inventado
 * — o que se grava vem do histórico de interrupções da própria EDP.
 *
 * ── LACUNAS CONHECIDAS ──────────────────────────────────────────────────────
 *   - Interrupção retomada em menos de um ciclo (15 min) não é vista em 3.
 *     Se ela for interrompida de novo depois, o histórico completo é gravado.
 *   - Sem retroativo: o snapshot guardava só o `status` traduzido.
 *
 * ── CUSTO NA CONTA EDP (compartilhada, P1-25) ───────────────────────────────
 * Só busca quando a nota ENTRA em 3 (memória do último código por nota). Nota
 * que fica dias interrompida custa 1 GET, não 1 por ciclo. Após restart a
 * memória zera e as MD em 3 são buscadas uma vez de novo — o upsert pelo Id da
 * interrupção torna isso inofensivo (idempotente). Memória em processo: vale o
 * contrato de instances=1 do CLAUDE.md.
 */

'use strict';

const log = require('./logger').forModule('interrupcoes');

const TIPOS_COLETADOS = new Set(['MD']);
const ES_INTERROMPIDA = 3;
const CONCORRENCIA = 4;

// note_id → último ExecutionStatus visto. Reconstruído a cada ciclo.
let _ultimoES = new Map();

/**
 * FUNÇÃO PURA (testável). Varre as equipes e devolve:
 *   - candidatas: MD em ExecutionStatus 3 que NÃO estavam em 3 no ciclo
 *     anterior (precisam de GET);
 *   - atual: mapa note_id → ExecutionStatus de todas as MD vistas agora.
 */
function selecionarCandidatas(teams, ultimoES = new Map()) {
  const candidatas = [];
  const atual = new Map();
  const vistas = new Set();
  for (const t of (teams || [])) {
    const notas = [
      ...(t.notasBaixadas   || []),
      ...(t.notasExecutadas || []),
    ];
    for (const n of notas) {
      if (!n || !n.id || vistas.has(n.id)) continue;
      const tipo = String(n.tipoCode || '').toUpperCase();
      if (!TIPOS_COLETADOS.has(tipo)) continue;
      vistas.add(n.id);
      const es = n.executionStatus ?? null;
      atual.set(n.id, es);
      if (es === ES_INTERROMPIDA && ultimoES.get(n.id) !== ES_INTERROMPIDA) {
        candidatas.push({
          note_id:   n.id,
          numero:    n.codigo || null,
          tipo,
          sector_id: t.sectorId || null,
          regional:  t.regional || null,
        });
      }
    }
  }
  return { candidatas, atual };
}

/**
 * FUNÇÃO PURA (testável): interrupções normalizadas (wpaService) → linhas da
 * tabela. Linha sem dia ou sem equipe é descartada — não dá pra atribuir.
 */
function montarLinhas(cand, interrupcoes, getRegional = () => null) {
  const linhas = [];
  for (const i of (interrupcoes || [])) {
    if (!i || !i.id || !i.dia || !i.equipe) continue;
    const equipe = String(i.equipe).trim();
    linhas.push({
      interrupcao_id: i.id,
      note_id:        cand.note_id,
      numero:         cand.numero,
      tipo:           cand.tipo,
      team_name:      equipe,
      // Regional da EQUIPE QUE INTERROMPEU (catálogo), não da que tem a nota
      // agora; o fallback só vale quando a sigla não está no catálogo.
      regional:       getRegional(equipe) || cand.regional || null,
      sector_id:      cand.sector_id,
      dia:            i.dia,
      instante:       i.instante,
      motivo:         i.motivo || null,
      observacao:     i.texto || null,
    });
  }
  return linhas;
}

let _avisouSemTabela = false;

async function runColetaInterrupcoes(teams) {
  if (process.env.DATA_MODE === 'mock') return;
  const { candidatas, atual } = selecionarCandidatas(teams, _ultimoES);

  // Só marca como "já em 3" o que deu certo; falha é retentada no próximo ciclo.
  const falharam = new Set();
  const proximo = () => {
    for (const id of falharam) atual.delete(id);
    _ultimoES = atual;
  };
  if (candidatas.length === 0) { proximo(); return; }

  const { getClient } = require('./dbClient');
  const sb = getClient();
  if (!sb) return;
  const { getNoteInterruptions } = require('./wpaService');
  const { getRegional } = require('./equipesOficiais');

  const linhas = [];
  for (let k = 0; k < candidatas.length; k += CONCORRENCIA) {
    const lote = candidatas.slice(k, k + CONCORRENCIA);
    await Promise.all(lote.map(async c => {
      try {
        const ints = await getNoteInterruptions(c.note_id);
        linhas.push(...montarLinhas(c, ints, getRegional));
      } catch (err) {
        falharam.add(c.note_id);
        log.warn('interrupcoes_fetch_falhou', { nota: c.numero || c.note_id, msg: err.message });
      }
    }));
  }

  if (linhas.length > 0) {
    const { error } = await sb.from('note_interrupcoes')
      .upsert(linhas.map(l => ({ ...l, updated_at: new Date().toISOString() })),
        { onConflict: 'interrupcao_id' });
    if (error) {
      // Tabela ausente = migration não aplicada. Avisa uma vez e não marca nada
      // como visto, pra coletar tudo quando a tabela existir.
      if (/note_interrupcoes|does not exist|relation/i.test(error.message || '')) {
        if (!_avisouSemTabela) {
          log.warn('interrupcoes_sem_tabela', { msg: 'aplique migrations/add_note_interrupcoes.sql' });
          _avisouSemTabela = true;
        }
      } else {
        log.warn('interrupcoes_upsert_falhou', { msg: error.message });
      }
      candidatas.forEach(c => falharam.add(c.note_id));
      proximo();
      return;
    }
  }
  proximo();
  log.info('interrupcoes_ok', {
    notas: candidatas.length - falharam.size, falhas: falharam.size, gravadas: linhas.length });
}

module.exports = {
  runColetaInterrupcoes,
  selecionarCandidatas, montarLinhas,
  _resetMemoria: () => { _ultimoES = new Map(); _avisouSemTabela = false; },
};
