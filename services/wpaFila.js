/**
 * services/wpaFila.js
 * Limite GLOBAL de requisições em voo contra a EDP, com fila e prioridade para o
 * painel.
 *
 * ⚠️ POR QUE EXISTE (19/10/2026, backlog P0-11 item 4, que é o P2-30): a EDP
 * questionou "diversas requisições congestionando o sistema". Cada caminho
 * tinha o seu limite e nenhum conhecia os outros: o snapshot faz até 16 em voo
 * por setor (`_mapConcurrent(…, 8)` × rejected/executed), e as caudas sem await
 * (classificação, detalhes, rejeições), as notas devolvidas e os jobs de hora
 * somam por cima. O total de requisições não muda aqui — o que muda é o PICO
 * que a EDP recebe: no máximo WPA_MAX_EM_VOO ao mesmo tempo, vindo de qualquer
 * lugar deste processo.
 *
 * Onde: services/wpaHttp.js, em volta SÓ da chamada HTTP. Por isso:
 *   - não há como travar: quem segura vaga não espera outra requisição (o
 *     login que o wpaFetch faz antes acontece fora da vaga, e pega a sua);
 *   - o timeout de 45s (P1-31) começa quando a requisição sai, não na fila;
 *   - backoff de retry do wpaFetch (setTimeout) não segura vaga.
 *
 * Prioridade: origem `painel:*` (contexto do wpaContador) passa na frente — um
 * clique de nota não espera a cauda do snapshot. Dentro de cada fila, FIFO.
 *
 * Estado de PROCESSO — vale porque o PM2 roda instances=1 (CLAUDE.md, regra 8).
 * O `gseq` (outro sistema na mesma VM) não passa por aqui (P0-9).
 */

'use strict';

const MAX_PADRAO = 6;

function _maxDoEnv() {
  const raw = process.env.WPA_MAX_EM_VOO;
  if (raw === undefined || raw === '') return MAX_PADRAO;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : MAX_PADRAO;
}

/**
 * Cria uma fila. `max` 0 = sem limite (o comportamento de antes).
 * Exportada para teste; o processo usa a instância padrão abaixo.
 */
function criarFila(max) {
  let emVoo = 0;
  let picoEmVoo = 0;
  let esperaMaxMs = 0;
  const prioritaria = [];
  const normal = [];

  function _liberarProximos() {
    while (emVoo < max && (prioritaria.length > 0 || normal.length > 0)) {
      const proximo = prioritaria.length > 0 ? prioritaria.shift() : normal.shift();
      emVoo++;
      if (emVoo > picoEmVoo) picoEmVoo = emVoo;
      proximo();
    }
  }

  /** Roda `fn` (que devolve Promise) quando houver vaga. */
  async function comVaga(ehPrioritaria, fn) {
    if (!(max > 0)) return fn();
    const t0 = Date.now();
    await new Promise(resolve => {
      (ehPrioritaria ? prioritaria : normal).push(resolve);
      _liberarProximos();
    });
    const espera = Date.now() - t0;
    if (espera > esperaMaxMs) esperaMaxMs = espera;
    try {
      return await fn();
    } finally {
      emVoo--;
      _liberarProximos();
    }
  }

  function estado() {
    return {
      max, emVoo, picoEmVoo, esperaMaxMs,
      naFila: prioritaria.length + normal.length,
    };
  }

  return { comVaga, estado };
}

const _padrao = criarFila(_maxDoEnv());

module.exports = {
  MAX_PADRAO,
  criarFila,
  comVaga: _padrao.comVaga,
  estado: _padrao.estado,
};
