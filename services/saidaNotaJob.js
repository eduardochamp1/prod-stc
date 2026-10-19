'use strict';

/**
 * services/saidaNotaJob.js — avalia um dia inteiro da aba "Saída da nota" (P2-70)
 * e grava em `saida_nota`. Usado pelo cron (04:30 BRT, D-1) e pelo
 * `scripts/backfill-saida-nota.js`.
 *
 * Por que à noite e para D-1 (SPEC A2): precisa da pausa apontada
 * (`sessao_intervalo`), que o cron das 03:10 só coleta para D-1, e do Fim do
 * Trabalho de cada nota. Não chama a EDP: lê o que já está no banco e a trilha
 * do gseq.
 *
 * Spec: docs/handoff/SPEC-saida-da-nota-2026-10-18.md §3–§7.
 */

const S = require('./saidaNota');
const Q = require('../db/saidaNotaQueries');
const { dateBRT } = require('./timeUtil');

const RAIO_SUGESTAO_M = 300;   // "junto do tablet" da sugestão de placa (diag-sugere-placa)

/**
 * Avalia o dia `data` (YYYY-MM-DD, BRT). Não grava — devolve as linhas.
 * @returns {Promise<{linhas: Array, resumo: object}>}
 */
async function avaliarDia({ data, pool, poolGseq, config = S.CONFIG_PADRAO }) {
  const versao = S.regraVersao(config);
  const t0 = Date.now();

  const brutas = await Q.notasConcluidasDoDia(pool, data);
  // Cada nota pertence ao dia em que a EXECUÇÃO começou. A mesma nota aparece em
  // snapshots de mais de um dia (1º backtest, 18/10/2026); sem este corte ela
  // seria gravada com o dia errado por quem rodasse depois.
  const notas = [];
  for (const n of brutas) {
    const janela = n.checkpoints ? S.janelaExecucao(n.checkpoints) : null;
    if (janela && !janela.motivo && dateBRT(new Date(janela.inicio)) !== data) continue;
    notas.push({ ...n, janela });
  }

  const alocacoes = await Q.alocacoesGseq(poolGseq);
  const { porEquipe: intervalos, linhas: nIntervalos } = await Q.intervalosDoDia(pool, data);

  for (const n of notas) {
    const c = S.placaCadastradaNaData(alocacoes, n.equipe, data);
    n.placa = c ? S.placaChave(c.placa) : null;
    n.placaFonte = n.placa ? c.fonte : null;
  }

  const comJanela = notas.filter(n => n.janela && !n.janela.motivo);
  let trilhas = new Map(), baldes = new Set(), frota = null;
  if (comJanela.length) {
    const ini = Math.min(...comJanela.map(n => n.janela.inicio)) - S.MAX_IDADE_ANTERIOR_MIN * 60000;
    const fim = Math.max(...comJanela.map(n => n.janela.fim)) + 30 * 60000;
    const placas = [...new Set(comJanela.map(n => n.placa).filter(Boolean))];
    trilhas = await Q.trilhaDasPlacas(poolGseq, placas, ini, fim);
    baldes = await Q.baldesFrota(poolGseq, ini, fim);
  }

  const linhas = notas.map(n => {
    const cadastro = n.endereco ? S.normalizaCoord(n.endereco.latitude, n.endereco.longitude) : null;
    const r = S.classificarNota({
      janela: n.janela, cadastro, placa: n.placa,
      pontos: n.placa ? (trilhas.get(n.placa) || []) : [],
      baldesFrota: baldes, intervalos: intervalos.get(n.equipe) || [],
      equipe: n.equipe, tipo: n.tipo,
    }, config);
    return {
      note_id: n.note_id, data, equipe: n.equipe, regional: n.regional,
      numero: n.numero, tipo: n.tipo, janela: n.janela,
      placa: n.placa, placaFonte: n.placaFonte, regraVersao: versao, ...r,
    };
  });

  // Sugestão de placa (SPEC A7): só exibição, nunca entra no cálculo (D4).
  // Lê a frota inteira só se houver nota sem cadastro ou com cadastro divergente.
  const precisam = linhas.filter(l => (l.status === 'sem_placa' || l.status === 'veiculo_divergente')
    && l.janela && l.janela.cpInicio);
  if (precisam.length) {
    const ini = Math.min(...precisam.map(l => l.janela.inicio)) - S.MAX_IDADE_ANTERIOR_MIN * 60000;
    const fim = Math.max(...precisam.map(l => l.janela.inicio)) + 15 * 60000;
    frota = await Q.frotaNoIntervalo(poolGseq, ini, fim);
    for (const l of precisam) {
      l.veiculosJunto = S.veiculosPerto(frota, l.janela.cpInicio, l.janela.inicio, RAIO_SUGESTAO_M);
    }
  }

  S.agruparOcorrencias(linhas);

  const porStatus = {};
  for (const l of linhas) porStatus[l.status] = (porStatus[l.status] || 0) + 1;
  return {
    linhas,
    resumo: {
      data, notas: linhas.length, porStatus, regra: versao,
      placasComTrilha: trilhas.size, veiculosNaFrota: frota ? frota.size : null,
      intervalosLidos: nIntervalos, ms: Date.now() - t0,
    },
  };
}

/** Lê a config de `app_settings.saida_nota`; inválida ou ausente → padrão (e avisa). */
async function lerConfig(getSetting) {
  try {
    const linha = getSetting ? await getSetting('saida_nota') : null;
    const v = S.validarConfig(linha ? linha.data : null);
    if (!v.ok) console.warn('[saida-nota] config inválida, usando o padrão:', v.erros.join('; '));
    return v.ok ? v.config : S.CONFIG_PADRAO;
  } catch (err) {
    console.warn('[saida-nota] config indisponível, usando o padrão:', err.message);
    return S.CONFIG_PADRAO;
  }
}

/**
 * Avalia e GRAVA um dia. Sem gseq configurado não faz nada (e diz) — nunca
 * grava linha que pareça "não saiu" por falta de dado.
 */
async function runSaidaNota({ data, pool, poolGseq, getSetting, gravar = true }) {
  if (!poolGseq) {
    console.warn('[saida-nota] GSEQ_DATABASE_URL não configurada — nada avaliado.');
    return { pulado: 'gseq_nao_configurado' };
  }
  const config = await lerConfig(getSetting);
  const { linhas, resumo } = await avaliarDia({ data, pool, poolGseq, config });
  if (resumo.intervalosLidos === 0) {
    console.warn(`[saida-nota] ${data}: nenhuma pausa apontada coletada — nada foi descontado das saídas.`);
  }
  resumo.gravadas = gravar ? await Q.gravar(pool, linhas) : 0;
  console.log('[saida-nota]', JSON.stringify(resumo));
  return resumo;
}

module.exports = { avaliarDia, lerConfig, runSaidaNota, RAIO_SUGESTAO_M };
