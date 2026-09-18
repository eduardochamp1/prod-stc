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

/** Normaliza célula de planilha: string, sem espaço nas bordas, maiúscula. */
function _norm(v) {
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase();
}

/**
 * Decide o destino de cada linha da planilha. PURA.
 *
 * @param {Array}  linhas         [{ linhaPlanilha, sigla, tipo, placa }]
 * @param {Array}  equipesAtuais  como o GET /admin/equipes devolve
 * @param {object} opts           { regional, setor, tipoPadrao, reativar }
 * @returns {{novas:Array, alteradas:Array, identicas:number,
 *            inativas:Array, erros:Array}}
 */
function montarPlano(linhas, equipesAtuais, opts = {}) {
  const { regional, setor, tipoPadrao, reativar = false } = opts;
  const out = { novas: [], alteradas: [], identicas: 0, inativas: [], erros: [] };

  // Validação do LOTE: um erro aqui invalida tudo, então sai cedo. Repare que
  // o erro não tem `linhaPlanilha` — não é de linha, é da configuração.
  const loteErro = (motivo) => {
    out.erros.push({ linhaPlanilha: null, siglaCrua: null, campo: null, valor: null, motivo });
    return out;
  };
  if (!RE_REG.test(regional || ''))   return loteErro('regional do lote inválida (use GUA, CAC ou SJC)');
  if (!RE_SETOR.test(setor || ''))    return loteErro('setor do lote inválido (use DESG, DEPT, DESC ou DSSJ)');
  if (!RE_TIPO.test(_norm(tipoPadrao))) {
    return loteErro('tipo padrão é obrigatório: `tipo` é NOT NULL no schema, '
      + 'e célula de tipo vazia precisa de um valor pra onde cair');
  }
  if ((linhas || []).length > MAX_LINHAS) {
    return loteErro(`lote tem ${linhas.length} linhas; o máximo é ${MAX_LINHAS}. `
      + 'O cadastro tem ~143 equipes — um arquivo maior que isso é engano.');
  }

  const atuais = new Map();
  (equipesAtuais || []).forEach(e => atuais.set(_norm(e.sigla), e));

  const vistas = new Map();   // sigla → linhaPlanilha da 1ª ocorrência

  for (const l of (linhas || [])) {
    const linhaPlanilha = l && l.linhaPlanilha;
    const siglaCrua = l && l.sigla;
    const sigla     = _norm(siglaCrua);
    const tipoCrua  = _norm(l && l.tipo);
    const tipo      = tipoCrua || _norm(tipoPadrao);
    const placaCrua = _norm(l && l.placa);
    const placa     = placaCrua || null;

    // Linha inteiramente vazia: planilha tem linha em branco no fim.
    if (!sigla && !tipoCrua && !placaCrua) continue;

    const erro = (campo, valor, motivo) =>
      out.erros.push({ linhaPlanilha, siglaCrua: siglaCrua || null, campo, valor, motivo });

    if (!RE_SIGLA.test(sigla)) {
      erro('sigla', siglaCrua, `sigla precisa ter de 4 a 12 letras ou números (leu ${sigla.length})`);
      continue;
    }
    if (vistas.has(sigla)) {
      erro(null, null, `sigla repetida: já aparece na linha ${vistas.get(sigla)} desta planilha`);
      continue;
    }
    vistas.set(sigla, linhaPlanilha);

    if (!RE_TIPO.test(tipo)) {
      erro('tipo', tipoCrua || tipoPadrao, 'tipo inválido (alfanumérico, máx 30)');
      continue;
    }
    if (placa && !RE_PLACA.test(placa)) {
      erro('placa', l && l.placa, `placa inválida (4 a 16 letras, números, espaço ou hífen — leu ${placa.length})`);
      continue;
    }

    const atual = atuais.get(sigla);

    if (!atual) {
      out.novas.push({ linhaPlanilha, sigla, setor, regional, tipo, placa });
      continue;
    }

    if (atual.ativo === false) out.inativas.push({ linhaPlanilha, sigla });

    const mudancas = [];
    const cmp = (campo, de, para) => {
      if (de !== para) mudancas.push({ campo, de, para });
    };
    cmp('setor',    _norm(atual.setor)    || null, setor);
    cmp('regional', _norm(atual.regional) || null, regional);
    cmp('tipo',     _norm(atual.tipo)     || null, tipo);
    cmp('placa',    _norm(atual.placa)    || null, placa);
    if (reativar && atual.ativo === false) mudancas.push({ campo: 'ativo', de: false, para: true });

    if (mudancas.length === 0) out.identicas++;
    else out.alteradas.push({ linhaPlanilha, sigla, setor, regional, tipo, placa, mudancas });
  }

  return out;
}

/**
 * Converte o plano nas linhas do upsert. Novas + alteradas; idênticas e erros
 * ficam de fora.
 *
 * ⚠️ TODAS as linhas devolvidas têm EXATAMENTE as mesmas chaves. O
 * `pgShim.upsert` monta as colunas do INSERT pela UNIÃO das chaves de todas as
 * linhas e põe `null` onde a chave falta (services/pgShim.js:294). Como `ativo`
 * é NOT NULL no schema, um lote misto — algumas linhas com `ativo`, outras sem
 * — derrubaria o statement inteiro. É a armadilha do P3-14.
 *
 * Por isso `ativo` entra em todas as linhas (quando reativar) ou em nenhuma.
 * Com `reativar: true`, marcar ativo=true no lote inteiro é correto: quem já
 * estava ativo não muda, e quem estava inativo é exatamente quem se quer de
 * volta. Equipe fora da planilha não entra no upsert, então não é tocada.
 */
function linhasParaUpsert(plano, opts = {}) {
  const { reativar = false } = opts;
  const agora = new Date().toISOString();

  return [...(plano.novas || []), ...(plano.alteradas || [])].map(e => {
    const row = {
      sigla:      e.sigla,
      setor:      e.setor,
      regional:   e.regional,
      tipo:       e.tipo,
      placa:      e.placa,
      updated_at: agora,
    };
    if (reativar) row.ativo = true;
    return row;
  });
}

module.exports = {
  validateEquipe,
  montarPlano,
  linhasParaUpsert,
  MAX_LINHAS,
  RE_SIGLA, RE_TIPO, RE_PLACA, RE_REG, RE_SETOR, RE_TIME,
};
