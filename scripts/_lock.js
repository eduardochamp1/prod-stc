/**
 * scripts/_lock.js — advisory lock compartilhado pros scripts de escrita.
 *
 * POR QUE EXISTE (28/08/2026, auditoria P2-43): o lock nasceu dentro do
 * `backfill-consolidate.js` depois do incidente de 09/07/2026 (P0-0), quando um
 * backfill improvisado como `for d in $(seq 0 60); do node -e ... &` virou ~60
 * processos node em paralelo, cada um abrindo um pool pg de ~10 conexões, e
 * estourou a VM de 3,8 GB sem swap — derrubando o Postgres por OOM. Produção
 * ficou `db:error` até o auto-restart.
 *
 * A lição virou código, mas em UM script só. Sete outros que escrevem no banco
 * ficaram sem ela, incluindo dois que reescrevem exatamente as tabelas de onde
 * saem os números reportados à EDP. Aqui a proteção vira função compartilhada.
 *
 * COMO FUNCIONA
 * ─────────────
 * `pg_try_advisory_lock` é por SESSÃO: o lock solta sozinho quando a conexão
 * cai. Isso importa porque significa que um crash NÃO deixa o próximo run
 * travado — diferente de lock em tabela, que precisaria de limpeza manual.
 *
 * Cada script usa a SUA chave. Dois scripts diferentes podem rodar juntos (são
 * tabelas diferentes); duas cópias do MESMO script, não.
 *
 * USO
 * ───
 *   const { comLock } = require('./_lock');
 *
 *   await comLock('backfill-subcat', { force: process.argv.includes('--force') },
 *     async () => {
 *       // o trabalho. Se outra cópia já roda, esta função NÃO é chamada e o
 *       // processo sai com código 1 e mensagem explicando.
 *     });
 *
 * `--force` segue SEM o lock. Existe pro caso de sobrar lock de um crash em que
 * a conexão não caiu (raro), e imprime aviso alto. Não use por conveniência.
 */

const { _getPool } = require('../services/pgShim');

/**
 * Deriva uma chave numérica estável (int32) a partir do nome do script.
 * Precisa ser estável entre execuções e distinta por script — hash simples
 * resolve, e colisão entre dois nomes só faria os dois se excluírem
 * mutuamente (conservador, não perigoso).
 *
 * ⚠️ `backfill-consolidate` continua usando a chave HISTÓRICA 429153001, não a
 * derivada. Trocá-la faria uma cópia nova conviver com uma cópia velha do
 * script durante um deploy — exatamente o que o lock existe pra impedir.
 */
const CHAVES_FIXAS = {
  'backfill-consolidate': 429153001,
};

function chaveDe(nome) {
  if (CHAVES_FIXAS[nome] !== undefined) return CHAVES_FIXAS[nome];
  let h = 0;
  for (let i = 0; i < nome.length; i++) {
    h = (h * 31 + nome.charCodeAt(i)) | 0;   // | 0 mantém em int32
  }
  // Positivo e fora da faixa das chaves fixas, pra não colidir com elas.
  return Math.abs(h) % 400000000;
}

/**
 * Tenta pegar o lock. Devolve o client dedicado que o segura, ou null.
 * O client é dedicado de propósito: o lock morre com a SESSÃO, então não pode
 * voltar pro pool enquanto o trabalho roda.
 */
async function acquire(chave) {
  const client = await _getPool().connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [chave]);
    if (rows[0] && rows[0].ok) return client;
    client.release();
    return null;
  } catch (e) {
    client.release();
    throw e;
  }
}

async function release(client, chave) {
  if (!client) return;
  try { await client.query('SELECT pg_advisory_unlock($1)', [chave]); } catch (_) { /* ignore */ }
  client.release();
}

/**
 * Roda `trabalho()` sob advisory lock. Se outra cópia do mesmo script já está
 * rodando e não houver `--force`, imprime a explicação e `process.exit(1)` —
 * sem chamar `trabalho()`.
 *
 * @param {string}   nome      identifica o script (ex.: 'backfill-subcat')
 * @param {object}   opts      { force?: boolean, silencioso?: boolean }
 * @param {Function} trabalho  async () => any
 * @returns {Promise<any>}     o que `trabalho()` devolver
 */
async function comLock(nome, opts, trabalho) {
  const { force = false, silencioso = false } = opts || {};
  const chave = chaveDe(nome);

  let client = await acquire(chave);
  if (!client) {
    if (!force) {
      console.error(`✖ Outra cópia de "${nome}" já está rodando (advisory lock ${chave} ocupado).`);
      console.error('  Espere ela terminar. Rodar em paralelo foi o que derrubou o Postgres em 09/07/2026.');
      console.error('  Se tem CERTEZA que não há outra cópia (ex.: sobrou de um crash), use --force.');
      process.exit(1);
    }
    console.warn(`⚠️  --force: seguindo SEM advisory lock em "${nome}". Garanta que NÃO há outra cópia rodando.`);
  } else if (!silencioso) {
    console.log(`🔒 advisory lock "${nome}" (${chave}) adquirido.`);
  }

  try {
    return await trabalho();
  } finally {
    await release(client, chave);
  }
}

module.exports = { comLock, chaveDe, CHAVES_FIXAS, _acquire: acquire, _release: release };
