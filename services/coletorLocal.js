/**
 * services/coletorLocal.js — a coleta da EDP rodando FORA da VM (P0-13).
 *
 * 29/10/2026. A EDP bloqueia o IP da VM (403 "Web App - Unavailable", P0-9) e
 * aceita a rede da Engelmig. Pedido do José: "um executável do nosso script de
 * coleta ... eu vou rodar na minha máquina e ela irá fazer um túnel para a nossa
 * VM e irá alimentar ela com as informações da consulta". Decisões dele, na
 * mesma conversa: grava direto no banco da VM (túnel SSH -L para o Postgres),
 * pasta com iniciar.bat, fechamento do D-1 na 1ª coleta do dia, e o botão do
 * painel vira um pedido no banco que este coletor atende.
 *
 * Roda as MESMAS rotinas do cronService (runJanela, runFechamento, runSnapshot);
 * só decide QUANDO. Tudo passa por uma fila de 1: janela, fechamento e pedido
 * nunca se sobrepõem. Fora delas, só lê/grava o banco (pedido e batimento a
 * cada 1 min) — nenhuma requisição à EDP.
 *
 * Ao ligar a máquina: fecha o D-1 se ainda não foi fechado (a partir das 05h), e
 * roda UMA janela se a última janela que já passou hoje não tem coleta. Nunca
 * repõe janelas perdidas uma a uma (seria rajada na EDP, P0-11).
 */

'use strict';

const cron = require('node-cron');
const { dateBRT, hourBRT, instanteBRT } = require('./timeUtil');
const log = require('./logger').forModule('coletor');

const PEDIDO_SETTING   = 'coleta_pedido';            // { ts, por } — gravado pela VM (botão do admin)
const ATENDIDO_SETTING = 'coleta_pedido_atendido';   // { ts: do pedido, em, ok }
const VIVO_SETTING     = 'coletor_vivo';             // { ts, host, versao } — batimento a cada 1 min
const POLL_MS = 60_000;

// ── funções puras (testáveis) ────────────────────────────────────────────────

/** O D-1 ainda não foi fechado? Só a partir das 05h BRT (antes disso, ontem pode ter plantão aberto). */
function fechamentoPendente(agora, carimbo, fechamentoH = 5) {
  if (hourBRT(agora) < fechamentoH) return false;
  const ontem = dateBRT(agora - 86400000);
  return !(carimbo && carimbo.date >= ontem);
}

/**
 * Horário (ms) da última janela de HOJE que já passou e ficou sem coleta, ou
 * null. `ultimaColetaMs` = snapshot_last_ok.
 */
function janelaPendente(agora, ultimaColetaMs, janelasH) {
  const hoje = dateBRT(agora);
  const passadas = janelasH.map(h => instanteBRT(hoje, h * 60)).filter(t => t <= agora);
  if (passadas.length === 0) return null;
  const ultima = passadas[passadas.length - 1];
  return Number.isFinite(ultimaColetaMs) && ultimaColetaMs >= ultima ? null : ultima;
}

/** Há pedido do painel ainda não atendido? */
function pedidoNovo(pedido, atendido) {
  if (!pedido || !pedido.ts) return false;
  return !(atendido && atendido.ts && atendido.ts >= pedido.ts);
}

/** Fila de 1: cada tarefa espera a anterior terminar (com ou sem erro). */
function criarFila() {
  let cauda = Promise.resolve();
  let ocupada = false;
  return {
    get ocupada() { return ocupada; },
    rodar(nome, fn) {
      const p = cauda.then(async () => {
        ocupada = true;
        const t0 = Date.now();
        try { await fn(); log.info('tarefa_ok', { tarefa: nome, s: Math.round((Date.now() - t0) / 1000) }); }
        catch (err) { log.error('tarefa_falhou', { tarefa: nome, code: err.code || null, msg: err.message }); }
        finally { ocupada = false; }
      });
      cauda = p;
      return p;
    },
  };
}

// ── o coletor ────────────────────────────────────────────────────────────────

/**
 * Liga o coletor. `deps` existe para teste; em produção vem tudo dos módulos.
 * Devolve { parar, fila, verificar } — `verificar()` é o passo de 1 min.
 */
function iniciarColetor(deps = {}) {
  const c = deps.cronService || require('./cronService');
  const sq = deps.queries || require('../db/queries');
  const { comOrigem } = deps.contador || require('./wpaContador');
  const agendar = deps.agendar || ((expr, fn) => cron.schedule(expr, fn, { timezone: 'America/Sao_Paulo' }));
  const agoraFn = deps.agora || Date.now;
  const host = deps.host || require('os').hostname();
  const fila = criarFila();

  const ler = async (k) => { const r = await sq.getSetting(k); return r && r.data; };

  async function fecharSePendente(origem) {
    const carimbo = await ler(c.FECHAMENTO_SETTING);
    if (!fechamentoPendente(agoraFn(), carimbo, c.FECHAMENTO_H)) return false;
    log.info('fechamento_pendente', { origem, ultimo: carimbo && carimbo.date });
    await comOrigem(`coletor:fechamento`, () => c.runFechamento());
    return true;
  }

  function janela(origem) {
    return fila.rodar(`janela:${origem}`, async () => {
      await fecharSePendente(origem);   // 1ª coleta do dia fecha o D-1 antes (decisão do José)
      await comOrigem('coletor:janela', () => c.runJanela());
    });
  }

  async function verificar() {
    const agora = agoraFn();
    await sq.setSetting(VIVO_SETTING, { ts: new Date(agora).toISOString(), host, versao: deps.versao || null })
      .catch(err => log.warn('batimento_falhou', { msg: err.message }));
    if (fila.ocupada) return;
    try {
      const [pedido, atendido] = [await ler(PEDIDO_SETTING), await ler(ATENDIDO_SETTING)];
      if (!pedidoNovo(pedido, atendido)) return;
      log.info('pedido_do_painel', { por: pedido.por, ts: pedido.ts });
      await fila.rodar('pedido', async () => {
        let ok = true;
        try { await comOrigem('coletor:pedido', () => c.runSnapshot()); }
        catch (err) { ok = false; throw err; }
        finally { await sq.setSetting(ATENDIDO_SETTING, { ts: pedido.ts, em: new Date(agoraFn()).toISOString(), ok }); }
      });
    } catch (err) {
      log.warn('verificar_falhou', { msg: err.message });
    }
  }

  async function aoLigar() {
    await fila.rodar('ao-ligar', async () => {
      await fecharSePendente('ao-ligar');
      const ultimaOk = await ler('snapshot_last_ok');
      const pend = janelaPendente(agoraFn(), ultimaOk && Date.parse(ultimaOk.ts), c.JANELAS_COLETA_H);
      if (pend) {
        log.info('janela_perdida', { janela: new Date(pend).toISOString(), ultima_coleta: ultimaOk && ultimaOk.ts });
        await comOrigem('coletor:janela', () => c.runJanela());
      }
    });
  }

  const jobs = [
    agendar(`0 ${c.JANELAS_COLETA_H.join(',')} * * *`, () => janela('agenda')),
    agendar(`0 ${c.FECHAMENTO_H} * * *`, () => fila.rodar('fechamento', () => fecharSePendente('agenda'))),
  ];
  const timer = (deps.setInterval || setInterval)(verificar, POLL_MS);
  const inicio = deps.semAoLigar ? Promise.resolve() : aoLigar();

  log.info('coletor_iniciado', { host, janelas: c.JANELAS_COLETA_H, fechamento: c.FECHAMENTO_H });
  return {
    fila, verificar, inicio,
    parar() { jobs.forEach(j => j && j.stop && j.stop()); (deps.clearInterval || clearInterval)(timer); },
  };
}

module.exports = {
  iniciarColetor,
  fechamentoPendente, janelaPendente, pedidoNovo, criarFila,
  PEDIDO_SETTING, ATENDIDO_SETTING, VIVO_SETTING,
};
