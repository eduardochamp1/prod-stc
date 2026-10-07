/**
 * services/supervisores.js
 *
 * Regras PURAS do supervisor da equipe (07/10/2026). Sem banco aqui — as rotas
 * em routes/index.js fazem o I/O e chamam estas funções, que a suíte testa.
 *
 * Duas coisas moram aqui:
 *
 *   1. `normalizarNome` — o catálogo existe pra que a mesma pessoa não vire
 *      duas ("joão silva" e "JOAO  SILVA "). Normalizar caixa e espaços resolve
 *      o caso barato; acento NÃO é removido de propósito: "JOÃO" e "JOAO" podem
 *      ser pessoas diferentes, e fundir duas pessoas é pior que duplicar uma
 *      (duplicata aparece no dropdown e alguém corrige; fusão some calada).
 *
 *   2. `supervisorVigente` — a regra de ATRIBUIÇÃO POR DATA. Quando a equipe
 *      troca de supervisor, a produção anterior continua do anterior. É a peça
 *      que a futura produtividade por supervisor vai usar; escrever e testar
 *      agora garante que o histórico gravado desde o dia 1 sirva pra ela.
 *
 * Schema: supabase/migrations/015_supervisores.sql
 */

'use strict';

const NOME_MIN = 3;
const NOME_MAX = 80;

/** MAIÚSCULAS, sem espaço nas pontas, espaços internos colapsados. */
function normalizarNome(nome) {
  if (nome === null || nome === undefined) return '';
  return String(nome).trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Lista de erros (vazia = válido). Recebe o nome CRU, normaliza antes de medir. */
function validarNome(nome) {
  const n = normalizarNome(nome);
  if (!n) return ['nome é obrigatório'];
  if (n.length < NOME_MIN || n.length > NOME_MAX) {
    return [`nome deve ter de ${NOME_MIN} a ${NOME_MAX} caracteres`];
  }
  // Só letras (com acento), espaço, ponto, hífen e apóstrofo. Sem dígito: nome
  // de supervisor com número quase sempre é sigla de equipe colada no campo
  // errado.
  if (!/^[A-ZÀ-Ý' .-]+$/.test(n)) return ['nome com caractere inválido'];
  return [];
}

/**
 * supervisor_id vigente para `sigla` no dia `dataISO` (YYYY-MM-DD).
 *
 * `historico` = linhas de equipe_supervisor_historico ({sigla, desde,
 * supervisor_id}), de qualquer equipe, em qualquer ordem.
 *
 * Vale a linha de maior `desde` que seja <= dataISO. Retorna:
 *   - o id (number) se havia supervisor;
 *   - null se a linha vigente diz "sem supervisor", OU se a data é anterior a
 *     qualquer registro (antes do primeiro vínculo a equipe não tinha
 *     supervisor CONHECIDO — não inventamos que o atual já valia).
 */
function supervisorVigente(historico, sigla, dataISO) {
  const s = String(sigla || '').toUpperCase().trim();
  let melhor = null;
  for (const h of historico || []) {
    if (String(h.sigla || '').toUpperCase().trim() !== s) continue;
    const desde = String(h.desde).slice(0, 10);
    if (desde > dataISO) continue;
    if (!melhor || desde > melhor.desde) melhor = { desde, id: h.supervisor_id };
  }
  return melhor && melhor.id !== null && melhor.id !== undefined ? Number(melhor.id) : null;
}

/**
 * Linha de histórico a gravar quando o PUT muda o supervisor, ou null quando
 * não há mudança (salvar o formulário sem mexer no supervisor não pode criar
 * vigência nova — senão cada edição de placa "re-data" o vínculo).
 */
function linhaHistorico({ sigla, idAtual, idNovo, hojeISO, usuario }) {
  const a = idAtual === undefined ? null : idAtual;
  const n = idNovo  === undefined ? null : idNovo;
  if ((a === null ? null : Number(a)) === (n === null ? null : Number(n))) return null;
  return {
    sigla: String(sigla).toUpperCase().trim(),
    desde: hojeISO,
    supervisor_id: n === null ? null : Number(n),
    registrado_por: usuario || null,
    registrado_em: new Date().toISOString(),
  };
}

module.exports = { normalizarNome, validarNome, supervisorVigente, linhaHistorico, NOME_MIN, NOME_MAX };
