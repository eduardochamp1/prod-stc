/**
 * services/escalaDia.js
 *
 * Escala CADASTRADA por dia, vinda de `/api/collaboratorshifts/{setor}/{mes}/{ano}`
 * e guardada em `escala_dia` (migration 013).
 *
 * Existe para o P1-26: `/admin/health` monta `teams_missing_today` iterando a
 * whitelist inteira e marcando quem não está em `teams_current`, SEM cruzar com
 * escala — então equipe de folga, férias ou afastamento aparece como "não logou"
 * todo dia. Com escala, "não logou" passa a significar **estava escalada e não
 * logou**, que é a regra de desvio nº 1 de qualquer alerta de turno.
 *
 * DIREÇÃO DO ERRO, deliberada: quando não há escala para a equipe no dia, ela
 * continua sendo reportada (`sem-dado`), não suprimida. Suprimir por falta de
 * dado esconderia ausência real, e aqui não se mascara número — para calar o
 * alerta exigimos evidência POSITIVA de folga.
 */

'use strict';

/**
 * Códigos que a EDP usa para dia NÃO trabalhado. Lista levantada dos três outros
 * projetos da empresa que consomem a mesma API (constante `ESCALA_EXCLUIR` no
 * legado), confirmada no backlog P1-26/P2-24.
 *   FOL folga · DR descanso remunerado · DES descanso · FER férias
 *   DIS dispensa · AFO afastamento · NA não aplicável · SAV sobreaviso
 *   SIN sindicato · TRE treinamento
 */
const ESCALA_NAO_TRABALHADA = new Set([
  'FOL', 'DR', 'DES', 'FER', 'DIS', 'AFO', 'NA', 'SAV', 'SIN', 'TRE',
]);

/**
 * O código representa dia não trabalhado?
 * Usa o primeiro token porque o código pode vir como "FOL" ou "FOL 00:00".
 * Ausência de código devolve `false` de propósito: é "sem evidência de folga",
 * não "está de folga" — ver a direção do erro no topo do arquivo.
 */
function isFolga(codigoEscala) {
  if (!codigoEscala) return false;
  const cod = String(codigoEscala).trim().toUpperCase();
  if (!cod) return false;
  return ESCALA_NAO_TRABALHADA.has(cod.split(/\s+/)[0]);
}

/**
 * A equipe estava escalada neste dia?
 *
 * Recebe as linhas de `escala_dia` da equipe no dia — uma por colaborador,
 * porque dois colaboradores da mesma equipe podem ter códigos diferentes no
 * mesmo dia (um em FOL, outro em T07). A equipe conta como escalada se **algum**
 * colaborador tem código de trabalho.
 *
 * @param {Array<{codigoEscala: string}>} rows
 * @returns {{escalada: boolean, motivo: 'escalada'|'folga'|'sem-dado', codigos: string[]}}
 */
function classificarDia(rows) {
  const lista = Array.isArray(rows) ? rows : [];
  if (lista.length === 0) {
    return { escalada: true, motivo: 'sem-dado', codigos: [] };
  }
  const codigos = lista.map(r => (r && r.codigoEscala) || '');
  const algumTrabalha = lista.some(r => !isFolga(r && r.codigoEscala));
  return {
    escalada: algumTrabalha,
    motivo: algumTrabalha ? 'escalada' : 'folga',
    codigos,
  };
}

/**
 * Escala de um dia, indexada por equipe (SIGLA em maiúsculas).
 *
 * Devolve `null` — e não um Map vazio — quando não há como saber (sem banco, ou
 * migration 013 não aplicada). O caller PRECISA distinguir "não tem escala
 * cadastrada" de "não consegui ler a escala": no segundo caso ele deve manter o
 * comportamento antigo em vez de suprimir equipe nenhuma.
 *
 * @param {string} dateISO  'YYYY-MM-DD'
 * @returns {Promise<Map<string, Array>|null>}
 */
async function getEscalaDoDia(dateISO) {
  let sb;
  try {
    ({ getClient: sb } = require('./dbClient'));
    sb = sb();
  } catch (_) {
    return null;
  }
  if (!sb) return null;

  const { data, error } = await sb
    .from('escala_dia')
    .select('equipe, colaborador_codigo, colaborador_nome, codigo_escala')
    .eq('data', dateISO);

  if (error) {
    console.warn(`[escalaDia] leitura de ${dateISO} falhou: ${error.message}` +
      ' — se for tabela ausente, rode supabase/migrations/013_escala_dia.sql');
    return null;
  }

  const porEquipe = new Map();
  for (const row of data || []) {
    const sigla = String(row.equipe || '').toUpperCase().trim();
    if (!sigla) continue;
    if (!porEquipe.has(sigla)) porEquipe.set(sigla, []);
    porEquipe.get(sigla).push({
      colaboradorCodigo: row.colaborador_codigo,
      colaboradorNome:   row.colaborador_nome,
      codigoEscala:      row.codigo_escala,
    });
  }
  return porEquipe;
}

module.exports = { ESCALA_NAO_TRABALHADA, isFolga, classificarDia, getEscalaDoDia };
