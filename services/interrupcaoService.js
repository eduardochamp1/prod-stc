/**
 * services/interrupcaoService.js
 *
 * Coleta das INTERRUPÇÕES de notas MD → tabela `note_interrupcoes`.
 * (15/10/2026: todos os tipos de nota — ver "TODOS OS TIPOS" abaixo.)
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

// ── TODOS OS TIPOS (15/10/2026) ─────────────────────────────────────────────
// Pedido do José: "amplia a coleta de interrupções para todos os tipos de nota,
// medindo o custo na conta EDP". Até aqui era só MD (pedido de 07/10, coluna
// INTERR da matriz). A matriz continua só MD Obsoleto/TL11 — o filtro dela é na
// LEITURA (db/queries._filtrarInterrupcoesPorSubcat); o balão de avisos conta tudo.
//
// ⚠️ RISCO DE CUSTO: o gatilho "ExecutionStatus 3 = interrompida" foi observado
// em MD (P2-55, hipótese). Se em outro tipo o 3 for o "em andamento" normal, cada
// nota em execução vira 1 GET. Por isso:
//   - TETO de GETs por ciclo (INTERR_MAX_GETS_CICLO, padrão 30). O excedente NÃO
//     é marcado como visto: entra no ciclo seguinte. MD tem prioridade no teto.
//   - MEDIÇÃO por tipo: GETs, quantos voltaram COM interrupção e quantos VAZIOS.
//     Vazio = GET gasto à toa = o 3 não significa interrompida naquele tipo.
//     Sai a cada ciclo no log e acumulado do dia em custoDoDia() (/admin/health).
//   - Rollback sem mexer em código: INTERR_TIPOS=MD no .env (csv; vazio = todos).
const ES_INTERROMPIDA = 3;
const CONCORRENCIA = 4;

function _tiposDoEnv() {
  const v = String(process.env.INTERR_TIPOS || '').trim();
  if (!v) return null;                                   // null = todos os tipos
  return new Set(v.split(',').map(x => x.trim().toUpperCase()).filter(Boolean));
}
function _tipoColetado(tipo, tipos) {
  return !!tipo && (!tipos || tipos.has(tipo));
}
function _maxGetsCiclo() {
  const n = Number(process.env.INTERR_MAX_GETS_CICLO);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

// Custo acumulado do DIA BRT (memória do processo — instances=1, CLAUDE.md).
let _custo = null;
function _custoHoje() {
  const { dateBRT } = require('./timeUtil');
  const dia = dateBRT();
  if (!_custo || _custo.dia !== dia) {
    _custo = { dia, ciclos: 0, gets: 0, comInterrupcao: 0, vazias: 0, falhas: 0,
      adiadas: 0, getsDetalhe: 0, porTipo: {} };
  }
  return _custo;
}
function _contarGet(c, tipo, resultado, origem = 'ciclo') {
  const t = c.porTipo[tipo] || (c.porTipo[tipo] = { gets: 0, comInterrupcao: 0, vazias: 0, falhas: 0 });
  c.gets++; t.gets++;
  if (origem === 'detalhe') c.getsDetalhe++;
  if (resultado === 'falha') { c.falhas++; t.falhas++; }
  else if (resultado === 'vazia') { c.vazias++; t.vazias++; }
  else { c.comInterrupcao++; t.comInterrupcao++; }
}
/** Custo do dia na conta EDP (cópia — quem lê não altera o contador). */
function custoDoDia() {
  return JSON.parse(JSON.stringify(_custoHoje()));
}

// note_id → último ExecutionStatus visto. Reconstruído a cada ciclo.
let _ultimoES = new Map();

/**
 * FUNÇÃO PURA (testável). Varre as equipes e devolve:
 *   - candidatas: notas em ExecutionStatus 3 que NÃO estavam em 3 no ciclo
 *     anterior (precisam de GET). MD primeiro (prioridade no teto do ciclo).
 *   - atual: mapa note_id → ExecutionStatus de todas as notas vistas agora.
 * `tipos`: Set de tipos coletados, ou null = todos (15/10/2026; antes só MD).
 */
function selecionarCandidatas(teams, ultimoES = new Map(), tipos = _tiposDoEnv()) {
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
      if (!_tipoColetado(tipo, tipos)) continue;
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
  // MD primeiro: era o único tipo até 15/10 e é o da coluna INTERR — o teto do
  // ciclo nunca pode deixá-la sem coleta por causa de tipo novo.
  candidatas.sort((a, b) => (a.tipo === 'MD' ? 0 : 1) - (b.tipo === 'MD' ? 0 : 1));
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

/**
 * FUNÇÃO PURA (testável): o payload CRU do details/optimized indica que vale
 * buscar o histórico? Qualquer tipo coletado com `Interruptions[]` não vazio
 * (15/10/2026; antes só MD). Custo só pra nota que DE FATO teve interrupção.
 */
function deveColetarDoDetalhe(raw, tipos = _tiposDoEnv()) {
  return !!(raw && _tipoColetado(String(raw.Type || '').toUpperCase(), tipos)
    && Array.isArray(raw.Interruptions) && raw.Interruptions.length > 0);
}

let _avisouSemTabela = false;

/**
 * Upsert idempotente em note_interrupcoes. Devolve { ok, semTabela }.
 */
async function _gravar(sb, linhas) {
  if (linhas.length === 0) return { ok: true, semTabela: false };
  const { error } = await sb.from('note_interrupcoes')
    .upsert(linhas.map(l => ({ ...l, updated_at: new Date().toISOString() })),
      { onConflict: 'interrupcao_id' });
  if (!error) return { ok: true, semTabela: false };
  // Tabela ausente = migration não aplicada. Avisa uma vez.
  if (/note_interrupcoes|does not exist|relation/i.test(error.message || '')) {
    if (!_avisouSemTabela) {
      log.warn('interrupcoes_sem_tabela', { msg: 'aplique migrations/add_note_interrupcoes.sql' });
      _avisouSemTabela = true;
    }
    return { ok: false, semTabela: true };
  }
  log.warn('interrupcoes_upsert_falhou', { msg: error.message });
  return { ok: false, semTabela: false };
}

/**
 * Coleta o histórico de interrupções de UMA nota (1 GET) e grava.
 * `cand` = { note_id, numero, tipo, sector_id, regional? }. Lança em falha de rede.
 *
 * 2º caminho (07/10/2026): a nota 045006455506 (EBGPR63) foi interrompida às
 * 12:12, retomada às 12:33 e concluída às 12:57 — o gatilho por ExecutionStatus
 * 3 do ciclo só a veria se um snapshot caísse nesses ~21 min. Toda MD concluída
 * ou rejeitada passa pelo cache de detalhes (noteDetailCacher), cujo payload já
 * traz `Interruptions[]`: quando ele vem preenchido, chamamos isto. Custo extra
 * só para as notas que de fato tiveram interrupção.
 */
async function coletarDaNota(cand) {
  const { getClient } = require('./dbClient');
  const sb = getClient();
  if (!sb) return 0;
  const { getNoteInterruptions } = require('./wpaService');
  const { getRegional } = require('./equipesOficiais');
  let ints;
  try { ints = await getNoteInterruptions(cand.note_id); }
  catch (err) { _contarGet(_custoHoje(), cand.tipo, 'falha', 'detalhe'); throw err; }
  const linhas = montarLinhas(cand, ints, getRegional);
  _contarGet(_custoHoje(), cand.tipo, linhas.length ? 'com' : 'vazia', 'detalhe');
  const r = await _gravar(sb, linhas);
  return r.ok ? linhas.length : 0;
}

async function runColetaInterrupcoes(teams) {
  if (process.env.DATA_MODE === 'mock') return;
  const sel = selecionarCandidatas(teams, _ultimoES);
  const { atual } = sel;
  const custo = _custoHoje();
  custo.ciclos++;

  // Teto de GETs (15/10/2026). O excedente entra em `falharam`: não fica marcado
  // como visto em 3 e volta como candidata no ciclo seguinte.
  const teto = _maxGetsCiclo();
  const candidatas = sel.candidatas.slice(0, teto);
  const adiadas = sel.candidatas.slice(teto);
  custo.adiadas += adiadas.length;

  // Só marca como "já em 3" o que deu certo; falha é retentada no próximo ciclo.
  const falharam = new Set(adiadas.map(c => c.note_id));
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
        const novas = montarLinhas(c, ints, getRegional);
        _contarGet(custo, c.tipo, novas.length ? 'com' : 'vazia');
        linhas.push(...novas);
      } catch (err) {
        _contarGet(custo, c.tipo, 'falha');
        falharam.add(c.note_id);
        log.warn('interrupcoes_fetch_falhou', { nota: c.numero || c.note_id, msg: err.message });
      }
    }));
  }

  const r = await _gravar(sb, linhas);
  if (!r.ok) {
    // Não marca nada como visto: coleta tudo de novo no próximo ciclo
    // (ou quando a tabela existir).
    candidatas.forEach(c => falharam.add(c.note_id));
    proximo();
    return;
  }
  proximo();
  const falhasRede = falharam.size - adiadas.length;
  const porTipo = {};
  for (const c of sel.candidatas) porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1;
  log.info('interrupcoes_ok', {
    notas: candidatas.length - falhasRede, falhas: falhasRede,
    adiadas: adiadas.length, teto, gravadas: linhas.length, candidatasPorTipo: porTipo,
    // Custo do dia até aqui: é a régua do "medindo o custo na conta EDP".
    dia: { gets: custo.gets, vazias: custo.vazias, comInterrupcao: custo.comInterrupcao, adiadas: custo.adiadas },
  });
}

module.exports = {
  runColetaInterrupcoes, coletarDaNota, custoDoDia,
  selecionarCandidatas, montarLinhas, deveColetarDoDetalhe,
  _resetMemoria: () => { _ultimoES = new Map(); _avisouSemTabela = false; _custo = null; },
};
