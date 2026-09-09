/**
 * db/heCadastroSeed.js
 *
 * Cadastro HE por equipe, TRANSCRITO da aba `DADOS` da planilha
 * `Medição Engelmig - CSD Guarapari (1).xlsx` (prints de 09/09/2026).
 *
 * ⚠️ ORIGEM: TRANSCRIÇÃO DE IMAGEM. LEIA ANTES DE CONFIAR.
 *
 * Eu levantei o risco de transcrever cadastro que vira fatura a partir de
 * print, e o José mandou transcrever deixando "editável e revisável"
 * (09/09/2026). É o que este arquivo é: um RASCUNHO. Toda linha entra no banco
 * com `he_revisado = false`, e a tela de Medição HE avisa enquanto houver
 * equipe não revisada no período. Nada aqui é tratado como verdade até alguém
 * confirmar contra a planilha.
 *
 * ── CONFERÊNCIA CRUZADA JÁ FEITA ────────────────────────────────────────────
 * O `tipo_breve` lido na aba DADOS foi cruzado com a coluna VALOR da aba
 * `H.E STC-PLT`, que é outra leitura independente do mesmo print. Conferem:
 *   A2 → R$ 376,28 : EBGPR63, EBGPR64, EBGPR65, ECMRT51, EPMFL33
 *   A1 → R$ 356,63 : ECACH50, ECPIU50
 *   L1 → R$ 297,54 : ECANC50, ECDMA50, ECGPR53, ECGPR90, ECGPR91,
 *                    ECMFL50, ECMFL51, ECMRT50, ECMRT80, ECPIU90
 *   L0M → R$ 122,14: ETGPR15, ETGPR16, ETGPR17, ETMRT16, ETPIU15
 * As equipes sem cruzamento (não apareceram na aba de medição) estão marcadas
 * com `conferido: false` — são as que mais precisam de revisão humana.
 *
 * ── DIVERGÊNCIA ENCONTRADA, PRA CONFERIR NA PLANILHA REAL ───────────────────
 * `ECMRT51` está como `A2 2P 22D` na aba DADOS (⇒ R$ 376,28), mas na aba de
 * medição algumas linhas dela aparecem com R$ 297,54, que é o valor de L1. Se
 * confirmado, são linhas cobradas a menos. É a classe de erro que desaparece
 * quando o valor sai do cadastro em vez de ser digitado linha a linha.
 *
 * ── OBSERVAÇÃO QUE CONECTA COM O P2-47 ──────────────────────────────────────
 * A aba DADOS tem 45 equipes e NÃO inclui `ETGPR18`, `ETGPR19`, `ETMRT15`
 * nem `ETPKE15` — que estão em `equipes_oficiais` como ativas. São 4 das 10
 * equipes que o P2-47 achou sem NENHUMA linha de escala no mês inteiro. Duas
 * fontes independentes apontando as mesmas equipes é indício forte de que
 * elas não operam mais. Ver P2-47 antes de cadastrá-las.
 */

'use strict';

/** Tipos de turma que têm valor/hora no contrato. */
const TIPOS_BREVE = ['A1', 'A2', 'A3', 'L0M', 'L1', 'L3'];

/**
 * Valores/hora da aba `Valores`. Vão pra `app_settings` na migration — daqui
 * são só a semente inicial.
 *
 * ⚠️ SEM VIGÊNCIA HISTÓRICA, por decisão do José em 09/09/2026: re-gerar uma
 * medição antiga depois de reajuste devolve o preço de hoje. A mitigação é o
 * XLSX carregar no rodapé o valor/hora usado e a data de geração — a planilha
 * enviada vira a evidência do preço aplicado.
 */
const VALORES_HORA_SEED = {
  A1:  356.63,
  A2:  376.28,
  A3:  332.65,
  L0M: 122.14,
  L1:  297.54,
  L3:  374.60,
};

/**
 * `tipo_planilha` é a coluna TIPO verbatim ("A3 2P 22D"). Guardo verbatim
 * porque é dela que `tipo_breve` é derivado, e porque conferir "A3 2P 22D"
 * contra a planilha é mais rápido que conferir só "A3".
 *
 * `conferido` = o tipo_breve bateu com o valor/hora na aba de medição.
 */
const CADASTRO_SEED = [
  // ── STC · BTZERO/CS (EB*) ────────────────────────────────────────────────
  { sigla: 'EBGPR62', cidade: 'GUARAPARI',          tipo_planilha: 'A3 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: false },
  { sigla: 'EBGPR63', cidade: 'GUARAPARI',          tipo_planilha: 'A2 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'EBGPR64', cidade: 'GUARAPARI',          tipo_planilha: 'A2 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'EBGPR65', cidade: 'GUARAPARI',          tipo_planilha: 'A2 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  // ── STC · Comercial (EC*) ────────────────────────────────────────────────
  { sigla: 'ECACH50', cidade: 'ALFREDO CHAVES',     tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECANC50', cidade: 'ANCHIETA',           tipo_planilha: 'L1 3P 30D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECDMA50', cidade: 'DOMINGOS MARTINS',   tipo_planilha: 'L1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECGPR51', cidade: 'GUARAPARI',          tipo_planilha: 'L1 3P 30D',  turno: 'DIURNO',  servico: 'STC', conferido: false },
  { sigla: 'ECGPR53', cidade: 'GUARAPARI',          tipo_planilha: 'L1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECGPR54', cidade: 'GUARAPARI',          tipo_planilha: 'L1 3P 30D',  turno: 'DIURNO',  servico: 'STC', conferido: false },
  { sigla: 'ECGPR81', cidade: 'GUARAPARI',          tipo_planilha: 'L1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: false },
  { sigla: 'ECGPR82', cidade: 'GUARAPARI',          tipo_planilha: 'L1 3P 30D',  turno: 'DIURNO',  servico: 'STC', conferido: false },
  { sigla: 'ECGPR90', cidade: 'GUARAPARI',          tipo_planilha: 'L1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECGPR91', cidade: 'GUARAPARI',          tipo_planilha: 'L1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECMFL50', cidade: 'MARECHAL FLORIANO',  tipo_planilha: 'L1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECMFL51', cidade: 'MARECHAL FLORIANO',  tipo_planilha: 'L1 3P 30D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECMRT50', cidade: 'MARATAÍZES',         tipo_planilha: 'L1 3P 30D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  // ⚠️ DADOS diz A2 (376,28); a aba de medição tem linhas com 297,54 (L1). Conferir.
  { sigla: 'ECMRT51', cidade: 'MARATAÍZES',         tipo_planilha: 'A2 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true, divergencia: 'medição tem linhas a R$ 297,54 (L1); DADOS diz A2' },
  { sigla: 'ECMRT80', cidade: 'MARATAÍZES',         tipo_planilha: 'L1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECPIU50', cidade: 'PIÚMA',              tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECPIU90', cidade: 'PIÚMA',              tipo_planilha: 'L1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ECPKE50', cidade: 'PRESIDENTE KENNEDY', tipo_planilha: 'A1 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: false },
  // ── PLT · Plantão (EP*) ──────────────────────────────────────────────────
  { sigla: 'EPACH30', cidade: 'ALFREDO CHAVES',     tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPANC30', cidade: 'ANCHIETA',           tipo_planilha: 'A1 2P 22D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPDMA30', cidade: 'DOMINGOS MARTINS',   tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPGPR30', cidade: 'GUARAPARI',          tipo_planilha: 'A1 3P 30D',  turno: 'NOTURNO', servico: 'PLT', conferido: false },
  { sigla: 'EPGPR31', cidade: 'GUARAPARI',          tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPGPR32', cidade: 'GUARAPARI',          tipo_planilha: 'A3 3P 30D',  turno: 'NOTURNO', servico: 'PLT', conferido: false, divergencia: 'leitura da coluna TIPO BREVE ficou ambígua no print — derivado de TIPO' },
  { sigla: 'EPGPR33', cidade: 'GUARAPARI',          tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPICO30', cidade: 'ICONHA',             tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPMFL30', cidade: 'MARECHAL FLORIANO',  tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPMFL31', cidade: 'MARECHAL FLORIANO',  tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPMFL32', cidade: 'MARECHAL FLORIANO',  tipo_planilha: 'A1 3P 30D',  turno: 'NOTURNO', servico: 'PLT', conferido: false },
  { sigla: 'EPMFL33', cidade: 'MARECHAL FLORIANO',  tipo_planilha: 'A2 2P 22D',  turno: 'DIURNO',  servico: 'PLT', conferido: true  },
  { sigla: 'EPMRT30', cidade: 'MARATAÍZES',         tipo_planilha: 'A2 3P 30D',  turno: 'NOTURNO', servico: 'PLT', conferido: false },
  { sigla: 'EPMRT31', cidade: 'MARATAÍZES',         tipo_planilha: 'A3 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPMRT32', cidade: 'MARATAÍZES',         tipo_planilha: 'A1 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  { sigla: 'EPPIU30', cidade: 'PIÚMA',              tipo_planilha: 'A3 3P 30D',  turno: 'NOTURNO', servico: 'PLT', conferido: false },
  { sigla: 'EPPIU31', cidade: 'PIÚMA',              tipo_planilha: 'A2 3P 30D',  turno: 'DIURNO',  servico: 'PLT', conferido: false },
  // ── STC · Ramal (ER*) ────────────────────────────────────────────────────
  { sigla: 'ERGPR70', cidade: 'GUARAPARI',          tipo_planilha: 'L3 2P 22D',  turno: 'DIURNO',  servico: 'STC', conferido: false },
  // ── STC · Corte L0 (ET*) ─────────────────────────────────────────────────
  { sigla: 'ETGPR15', cidade: 'GUARAPARI',          tipo_planilha: 'L0M 1P 22D', turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ETGPR16', cidade: 'GUARAPARI',          tipo_planilha: 'L0M 1P 22D', turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ETGPR17', cidade: 'GUARAPARI',          tipo_planilha: 'L0M 1P 22D', turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ETMRT16', cidade: 'MARATAÍZES',         tipo_planilha: 'L0M 1P 22D', turno: 'DIURNO',  servico: 'STC', conferido: true  },
  { sigla: 'ETPIU15', cidade: 'PIÚMA',           tipo_planilha: 'L0M 1P 22D', turno: 'DIURNO',  servico: 'STC', conferido: true  },
];

/**
 * FUNÇÃO PURA (testável): `tipo_breve` a partir da coluna TIPO da planilha.
 *
 * A coluna vem como "A3 2P 22D" / "L0M 1P 22D" — o tipo é o primeiro token.
 * Derivar em vez de transcrever a coluna TIPO BREVE separadamente elimina uma
 * leitura de print: se as duas discordarem, a divergência aparece em vez de
 * ser silenciosamente escolhida por mim.
 *
 * Devolve null quando não reconhece — nunca chuta, porque tipo_breve errado
 * = valor/hora errado = fatura errada.
 */
function tipoBreveDoTipoPlanilha(tipo) {
  if (tipo == null) return null;
  const token = String(tipo).trim().toUpperCase().split(/[\s\-/]+/)[0];
  return TIPOS_BREVE.includes(token) ? token : null;
}

/**
 * FUNÇÃO PURA (testável): valida uma linha de cadastro HE.
 * Devolve array de erros (vazio = ok).
 */
function validarCadastroHe(linha) {
  const erros = [];
  const l = linha || {};
  if (!/^[A-Z0-9]{4,12}$/.test(String(l.sigla || '').toUpperCase())) {
    erros.push('sigla inválida');
  }
  if (!String(l.cidade || '').trim()) erros.push('cidade vazia');
  if (!['STC', 'PLT'].includes(String(l.servico || '').toUpperCase())) {
    erros.push('servico deve ser STC ou PLT');
  }
  if (!tipoBreveDoTipoPlanilha(l.tipo_planilha)) {
    erros.push(`tipo_planilha não resolve num tipo conhecido (${TIPOS_BREVE.join('/')})`);
  }
  return erros;
}

/** As linhas com `tipo_breve` já derivado, pro script e pros testes. */
function seedResolvido() {
  return CADASTRO_SEED.map(l => ({
    ...l,
    tipo_breve: tipoBreveDoTipoPlanilha(l.tipo_planilha),
  }));
}

module.exports = {
  TIPOS_BREVE,
  VALORES_HORA_SEED,
  CADASTRO_SEED,
  tipoBreveDoTipoPlanilha,
  validarCadastroHe,
  seedResolvido,
};
