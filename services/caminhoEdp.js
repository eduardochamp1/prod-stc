/**
 * services/caminhoEdp.js — o caminho até a EDP está de pé? (09/11/2026, P0-15)
 *
 * POR QUE EXISTE: o relay (P0-9) ficou caído de 08/11 19h a 09/11 23h e ninguém
 * soube até o José abrir o painel, que só dizia "Sem coleta hoje". Pedido dele em
 * 09/11/2026, depois da recuperação automática (P0-14): coletar assim que o
 * túnel voltar, avisar quando cair e dizer o motivo no painel.
 *
 * Um estado só, três consumidores:
 *   - `coleta_caminho` em app_settings (e em memória): { code, desde, ts, rotina }
 *     enquanto a coleta falha por falta de CAMINHO (proxy/túnel, IP bloqueado —
 *     os CODIGOS_CAMINHO do wpaErros). Some no primeiro ciclo que der certo.
 *   - painel: /api/teams devolve `coleta_em.falha` e a tela diz o motivo;
 *   - alerta: 1 mensagem no Teams quando cai e 1 quando volta (se houver
 *     WATCHDOG_TEAMS_WEBHOOK);
 *   - vigia: com falha registrada e WPA_PROXY, testa o túnel a cada minuto —
 *     porta local e, com ela de pé, um CONNECT pelo relay (10/11/2026: a porta
 *     aceitava com o relay mudo; não é requisição HTTP à EDP) — e, quando volta,
 *     roda a janela perdida ou a recuperação — no máximo 1 tentativa a cada
 *     30 min.
 *
 * Em memória por processo (instances=1, regra 8); o banco é só para sobreviver
 * a restart.
 */

'use strict';

const { dateBRT, instanteBRT } = require('./timeUtil');
const log = require('./logger').forModule('caminho');

const SETTING = 'coleta_caminho';
const TENTATIVA_MIN_MS = 30 * 60_000;
const SAUDE_MARGEM_MS = 45 * 60_000;

const MOTIVOS = {
  WPA_PROXY_INDISPONIVEL: 'túnel até a EDP fora do ar (o relay no computador do José não está conectado)',
  WPA_PROXY_SEM_ROTA: 'o relay está ligado, mas o computador dele não alcança a EDP (VPN desconectada?)',
  WPA_PROXY_RECUSOU: 'o relay recusou a conexão com a EDP',
  WPA_IP_BLOQUEADO: 'a EDP está recusando o IP de saída',
};

let _falha = null;          // { code, desde, ts, rotina } | null
let _ultimaTentativa = 0;
let _timer = null;

const sq = () => require('../db/queries');
const emTeste = () => process.env.NODE_ENV === 'test';

/** Texto curto do motivo, para alerta e log. */
function descreverFalha(code) {
  return MOTIVOS[code] || `sem acesso à EDP (${code || 'motivo desconhecido'})`;
}

/** Falha de caminho em aberto, ou null. Cópia — quem lê não mexe no estado. */
function falhaAtual() {
  return _falha ? { ..._falha } : null;
}

async function _persistir(valor) {
  if (emTeste()) return;
  try { await sq().setSetting(SETTING, valor); }
  catch (err) { log.warn('caminho_nao_gravado', { msg: err.message }); }
}

/** Lê do banco o que o processo anterior deixou (boot). */
async function hidratar() {
  try {
    const r = await sq().getSetting(SETTING);
    const d = r && r.data;
    _falha = d && d.code ? { code: d.code, desde: d.desde, ts: d.ts, rotina: d.rotina || null } : null;
  } catch (err) {
    log.warn('caminho_nao_lido', { msg: err.message });
  }
  return falhaAtual();
}

/**
 * Manda 1 mensagem para o Teams, se houver webhook. Nunca lança. O corpo leva
 * `text` (conector antigo) e um cartão adaptável (webhook do Workflows).
 */
async function alertarTeams(texto, { fetchFn = globalThis.fetch, webhook = process.env.WATCHDOG_TEAMS_WEBHOOK } = {}) {
  const url = String(webhook || '').trim();
  if (!url || typeof fetchFn !== 'function') return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        type: 'message',
        text: texto,
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: texto, wrap: true }] },
        }],
      }),
    });
    clearTimeout(t);
    if (!r.ok) { log.warn('alerta_teams_recusado', { status: r.status }); return false; }
    return true;
  } catch (err) {
    log.warn('alerta_teams_falhou', { msg: err.message });
    return false;
  }
}

const _hm = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

/**
 * A rotina `rotina` não coletou por falta de caminho. A 1ª vez abre a falha
 * (e avisa); as seguintes só atualizam `ts` — `desde` é de quando começou.
 */
async function registrarFalha(rotina, code, { agora = Date.now(), alertar = alertarTeams } = {}) {
  const ts = new Date(agora).toISOString();
  const nova = !_falha;
  _falha = { code: code || 'WPA_SEM_CAMINHO', desde: nova ? ts : _falha.desde, ts, rotina };
  await _persistir(_falha);
  if (nova) {
    log.error('caminho_caiu', { rotina, code: _falha.code });
    await alertar(`🔴 WPA Monitor — coleta da EDP parada desde ${_hm(agora)}: ${descreverFalha(_falha.code)}. `
      + 'O painel segue no ar com os dados já coletados; os dias perdidos são recuperados sozinhos quando o acesso voltar.');
  }
  return falhaAtual();
}

/** Um ciclo chegou à EDP. Fecha a falha em aberto, se houver (e avisa). */
async function registrarOk({ agora = Date.now(), alertar = alertarTeams } = {}) {
  if (!_falha) return false;
  const era = _falha;
  _falha = null;
  _ultimaTentativa = 0;
  await _persistir({ code: null, ts: new Date(agora).toISOString(), ultimaFalha: era });
  log.info('caminho_voltou', { code: era.code, desde: era.desde });
  await alertar(`🟢 WPA Monitor — coleta da EDP voltou às ${_hm(agora)} (estava parada desde ${_hm(Date.parse(era.desde))} de ${dateBRT(Date.parse(era.desde)).split('-').reverse().slice(0, 2).join('/')}).`);
  return true;
}

/**
 * O vigia deve tentar a coleta agora? Puro (teste). Só com falha em aberto, a
 * túnel respondendo (porta + CONNECT) e 30 min desde a última tentativa.
 */
function deveTentar({ falha, portaOk, agora, ultimaTentativa, minMs = TENTATIVA_MIN_MS }) {
  if (!falha || !portaOk) return false;
  return !ultimaTentativa || agora - ultimaTentativa >= minMs;
}

/**
 * Saúde da coleta no modelo de janelas (P0-12), para o /health. Puro (teste).
 * Ruim se há falha de caminho em aberto, ou se a última janela de hoje já
 * passou há mais de 45 min e o último snapshot é anterior a ela.
 */
function avaliarSaude({ agora = Date.now(), ultimoSnapshotMs = null, janelasH = [], falha = null, margemMs = SAUDE_MARGEM_MS }) {
  if (falha) {
    return { ok: false, reason: `coleta da EDP parada desde ${_hm(Date.parse(falha.desde))}: ${descreverFalha(falha.code)}` };
  }
  const hoje = dateBRT(agora);
  const passadas = janelasH.map(h => ({ h, t: instanteBRT(hoje, h * 60) })).filter(j => j.t + margemMs <= agora);
  if (passadas.length === 0) return { ok: true };
  const ultima = passadas[passadas.length - 1];
  if (!Number.isFinite(ultimoSnapshotMs) || ultimoSnapshotMs < ultima.t) {
    return { ok: false, reason: `a janela das ${ultima.h}h não coletou (último snapshot é anterior a ela)` };
  }
  return { ok: true };
}

/**
 * Liga o vigia do túnel. `rodar()` faz a coleta (janela perdida ou recuperação);
 * `testarPorta()` devolve { ok }. Devolve { parar, passo } — `passo()` é o teste
 * de 1 min, exposto para teste.
 */
function iniciarVigia({ rodar, testarPorta, intervaloMs = 60_000, agoraFn = Date.now } = {}) {
  let ocupado = false;
  async function passo() {
    if (ocupado || !_falha) return false;
    // 10/11/2026: dentro dos 30 min da última tentativa nem testa — o teste
    // passou a ser um CONNECT pelo relay (abre um TCP até a EDP quando dá certo).
    if (_ultimaTentativa && agoraFn() - _ultimaTentativa < TENTATIVA_MIN_MS) return false;
    ocupado = true;
    try {
      const porta = await testarPorta();
      const agora = agoraFn();
      if (!deveTentar({ falha: _falha, portaOk: !!(porta && porta.ok), agora, ultimaTentativa: _ultimaTentativa })) return false;
      const anterior = _ultimaTentativa;
      _ultimaTentativa = agora;
      log.info('tunel_voltou_tentando', { code: _falha.code, desde: _falha.desde });
      // 10/11/2026: `rodar()` devolve false quando não rodou (outra coleta em
      // curso, _comColeta) — aí a tentativa não conta e o próximo passo testa de
      // novo, em vez de esperar 30 min por uma coleta que nem começou.
      if ((await rodar()) === false) { _ultimaTentativa = anterior; return false; }
      return true;
    } catch (err) {
      log.error('vigia_falhou', { code: err.code || null, msg: err.message });
      return false;
    } finally {
      ocupado = false;
    }
  }
  if (intervaloMs > 0) {
    _timer = setInterval(() => { passo(); }, intervaloMs);
    if (_timer.unref) _timer.unref();
  }
  return { passo, parar: pararVigia };
}

function pararVigia() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Só para teste: zera o estado em memória. */
function _reset() { _falha = null; _ultimaTentativa = 0; pararVigia(); }

module.exports = {
  SETTING, TENTATIVA_MIN_MS,
  falhaAtual, hidratar, registrarFalha, registrarOk,
  descreverFalha, alertarTeams,
  deveTentar, avaliarSaude,
  iniciarVigia, pararVigia,
  _reset,
};
