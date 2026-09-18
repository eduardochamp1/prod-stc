/**
 * services/equipesImport.js
 *
 * Importação de equipes oficiais a partir de planilha, e as regras de
 * validação de equipe — que viviam em routes/index.js:1856 e vieram pra cá
 * em 17/09/2026 pra existirem UMA vez só (a rota passa a importar daqui).
 *
 * Tudo aqui é PURO: sem banco, sem DOM, sem rede. A rota fina que envolve este
 * módulo está em routes/index.js (POST /admin/equipes/importar).
 *
 * Spec: docs/handoff/SPEC-import-equipes-2026-09-17.md
 */

'use strict';

const RE_SIGLA = /^[A-Z0-9]{4,12}$/i;
const RE_TIPO  = /^[A-Z0-9 ÁÉÍÓÚÃÕÇ-]{1,30}$/i;  // tipo é livre (operacional)
const RE_PLACA = /^[A-Z0-9 -]{4,16}$/i;
const RE_REG   = /^(GUA|CAC|SJC)$/;                // SJC adicionado 08/06/2026
const RE_SETOR = /^(DESG|DEPT|DESC|DSSJ)$/;        // DSSJ = CSD São José
const RE_TIME  = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * Teto de linhas por lote. O cadastro tem ~143 equipes; um arquivo com
 * milhares de linhas é engano, não uso. Recusamos antes de montar SQL.
 */
const MAX_LINHAS = 500;

/** Validação de UMA equipe. Comportamento idêntico ao antigo _validateEquipe. */
function validateEquipe(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body inválido'];
  if (!RE_SIGLA.test(body.sigla || ''))      errors.push('sigla inválida (4-12 alfanuméricos)');
  if (!RE_SETOR.test(body.setor || ''))      errors.push('setor deve ser DESG, DEPT, DESC ou DSSJ');
  if (!RE_REG.test(body.regional || ''))     errors.push('regional deve ser GUA, CAC ou SJC');
  if (!RE_TIPO.test(body.tipo || ''))        errors.push('tipo inválido (alfanumérico, máx 30)');
  // placa é opcional
  if (body.placa && !RE_PLACA.test(body.placa)) errors.push('placa inválida');
  // Escala opcional: aceita "HH:MM" ou "HH:MM:SS"
  if (body.escala_inicio && !RE_TIME.test(String(body.escala_inicio))) errors.push('escala_inicio inválido (use HH:MM)');
  if (body.escala_fim    && !RE_TIME.test(String(body.escala_fim)))    errors.push('escala_fim inválido (use HH:MM)');
  return errors;
}

module.exports = {
  validateEquipe,
  MAX_LINHAS,
  RE_SIGLA, RE_TIPO, RE_PLACA, RE_REG, RE_SETOR, RE_TIME,
};
