/**
 * test/heTela.test.js
 *
 * Fase 3 da SPEC-medicao-he-2026-09-09 — sub-aba "Medição HE" e o XLSX.
 *
 * O produto aqui é a ORDEM das colunas: a planilha vai para a EDP e é colada
 * num template existente. Coluna fora de lugar quebra o encaixe em silêncio, e
 * nenhum teste de cálculo pega isso.
 *
 * Não há harness de frontend (risco H11 do backlog), então valem as invariantes
 * estruturais que dá pra provar lendo o arquivo — no estilo do resto da suíte.
 * Limite explícito: isto NÃO prova que a tela renderiza nem que o Excel abre.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC   = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ROTAS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.js'), 'utf8');

/** As 25 colunas, na ordem da aba `H.E STC-PLT` (spec §3). */
const ORDEM = [
  'EQUIPE', 'TIPO SERVIÇO', 'CIDADE', 'ÚLTIMA NOTA', 'CONCLUSÃO ÚLTIMA NOTA (h)',
  'QTD', 'VALOR', 'INICIO ESCALA', 'INICIO SESSÃO', 'ANTECIPAÇÃO',
  'FIM DE ESCALA', 'FIM SESSÃO', 'PRORROGAÇÃO', 'TOTAL (DECIMAL)', 'TOTAL (M)',
  'DATA', 'VALOR TOTAL',
  'PARECER ENGELMIG', 'JUSTIFICATIVA ENGELMIG', 'AUTORIZADO POR',
  'PARECER EDP', 'JUSTIFICATIVA EDP', 'OBSERVAÇÕES FINAIS',
  'ENVIAR COBRANÇA?', 'TOTAL FINAL',
];

function blocoHeColunas() {
  const i = SRC.indexOf('const HE_COLUNAS = [');
  assert.ok(i > -1, 'não achei HE_COLUNAS');
  return SRC.slice(i, SRC.indexOf('];', i));
}

// ─────────────────────────────────────────────────────────────────────────────
// A ordem das colunas — é o produto
// ─────────────────────────────────────────────────────────────────────────────

test('as 25 colunas existem, na ordem exata da planilha', () => {
  const bloco = blocoHeColunas();
  let cursor = -1;
  for (const col of ORDEM) {
    const at = bloco.indexOf(`'${col}'`);
    assert.ok(at > -1, `coluna ausente: ${col}`);
    assert.ok(at > cursor, `coluna fora de ordem: ${col}`);
    cursor = at;
  }
});

test('as 25 da planilha vêm PRIMEIRO; extras só depois', () => {
  // ⚠️ Esta é a invariante que protege o encaixe no template do José: as 25
  // primeiras são a planilha dele, na ordem dela. Coluna nova inserida no MEIO
  // desloca todas as seguintes e quebra o "colar" em silêncio — nenhum teste
  // de cálculo pegaria.
  //
  // Em 09/09/2026 entraram INÍCIO DESLOC. ÚLTIMA NOTA e ACORDO 30 MIN (regra do
  // acordo 30 min), e foram pro FIM justamente por isso.
  const bloco = blocoHeColunas();
  const achadas = (bloco.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
  assert.deepEqual(achadas.slice(0, ORDEM.length), ORDEM,
    'as 25 primeiras têm de ser exatamente a planilha, na ordem');
  const extras = achadas.slice(ORDEM.length);
  assert.deepEqual(extras, ['INÍCIO DESLOC. ÚLTIMA NOTA', 'ACORDO 30 MIN']);
});

test('a linha de dados tem uma posição por coluna', () => {
  // 17 valores + 8 vazios de parecer + 2 da regra nova = 27.
  const i = SRC.indexOf('aoa.push([');
  const bloco = SRC.slice(i, SRC.indexOf(']);', i));
  assert.match(bloco, /_heDataBR\(l\.desloc_ultima_nota\)/);
  assert.match(bloco, /l\.acordo_30 === true \? 'Acordo 30 min' : ''/);
});

test('as 8 colunas de parecer saem vazias na linha de dados', () => {
  // Decisão de 09/09/2026: o sistema não inventa parecer.
  const i = SRC.indexOf('// R..Y — parecer humano');
  assert.ok(i > -1, 'não achei o preenchimento das colunas de parecer');
  const linha = SRC.slice(SRC.lastIndexOf('\n', i), i);
  assert.equal((linha.match(/''/g) || []).length, 8,
    'devem ser exatamente 8 strings vazias, uma por coluna R..Y');
});

test('a linha de dados tem 25 posições', () => {
  const i = SRC.indexOf('aoa.push([');
  assert.ok(i > -1);
  const bloco = SRC.slice(i, SRC.indexOf('нет', i) > -1 ? 0 : SRC.indexOf(']);', i));
  // 17 valores + 8 vazios. Conta as vírgulas de topo é frágil, então checa as
  // âncoras: primeira e última coluna de dado.
  assert.match(bloco, /l\.equipe/);
  assert.match(bloco, /l\.valor_total == null \? '' : l\.valor_total/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Honestidade do XLSX
// ─────────────────────────────────────────────────────────────────────────────

test('datas saem como TEXTO, não como Date', () => {
  // Objeto Date faz SheetJS/Excel reinterpretarem fuso; 3h aqui muda dinheiro.
  const i = SRC.indexOf('async function downloadHeXLSX');
  const bloco = SRC.slice(i, SRC.indexOf('/**', i + 10));
  assert.match(bloco, /_heDataBR\(l\.inicio_escala\)/);
  assert.match(bloco, /_heDataBR\(l\.fim_sessao\)/);
  assert.doesNotMatch(bloco, /new Date\(l\./, 'nada de Date por linha');
});

test('a limitação do dropdown está escrita no código', () => {
  // SheetJS community não escreve dataValidation (conferido: 0 ocorrências no
  // bundle). Prometer dropdown e não entregar seria pior que não prometer.
  const i = SRC.indexOf('async function downloadHeXLSX');
  const doc = SRC.slice(Math.max(0, i - 1400), i);
  assert.match(doc, /SEM DROPDOWN/);
  assert.match(doc, /dataValidation/);
});

test('a lista AFIRMATIVAS vai completa, em aba própria', () => {
  // Decisão de 09/09/2026: lista inteira, sem subconjunto por coluna.
  for (const v of ['SIM', 'NÃO', 'PROCEDENTE', 'IMPROCEDENTE', 'ACORDO 30 MINUTOS',
                   'EQUIPE PARA COMPENSAÇÃO', 'SEM AUTORIZAÇÃO', 'STC ATENDENDO PO']) {
    assert.ok(SRC.includes(`'${v}'`), `AFIRMATIVAS sem ${v}`);
  }
  assert.match(SRC, /book_append_sheet\(wb,[\s\S]{0,200}'AFIRMATIVAS'\)/);
});

test('a procedência do preço vai numa aba, não como rodapé nos dados', () => {
  // Rodapé na aba de dados atrapalharia colar no template. A função
  // evidenciária é a mesma: sem vigência no banco, a planilha é a prova.
  assert.match(SRC, /'PROCEDÊNCIA'\)/);
  const i = SRC.indexOf("'PROCEDÊNCIA'");
  // Janela de 2400: a aba cresceu quando o piso entrou (09/09/2026) e a de
  // 1200 deixou de alcançar as primeiras linhas.
  const bloco = SRC.slice(Math.max(0, i - 2400), i);
  assert.match(bloco, /Valor\/hora aplicado/);
  assert.match(bloco, /Gerado em/);
  assert.match(bloco, /sem cadastro HE/i);
  // O piso faz parte de COMO o número foi produzido: sem ele registrado, uma
  // reconferência futura com outro piso não fecha e ninguém sabe por quê.
  assert.match(bloco, /Piso aplicado \(min\)/);
  assert.match(bloco, /Linhas descartadas pelo piso/);
});

// ─────────────────────────────────────────────────────────────────────────────
// A tela avisa em vez de exibir número que não se sustenta
// ─────────────────────────────────────────────────────────────────────────────

test('os cinco avisos que impedem confiar no total estão na tela', () => {
  const i = SRC.indexOf('function renderHeMedicao');
  const bloco = SRC.slice(i, SRC.indexOf('async function downloadHeXLSX', i));
  assert.match(bloco, /schema_sem_he/,    'banco sem o cadastro HE');
  assert.match(bloco, /sem_cadastro/,     'equipe sem tipo_breve');
  assert.match(bloco, /nao_revisadas/,    'cadastro transcrito não conferido');
  assert.match(bloco, /dias_sem_escala/,  'sessão sem janela de escala');
  assert.match(bloco, /incompletas/,      'sessão ainda aberta');
  assert.match(bloco, /origem_valores === 'seed'/, 'preço vindo do código');
});

test('valor ausente aparece como travessão, nunca como zero', () => {
  const i = SRC.indexOf('function renderHeMedicao');
  const fn = SRC.slice(i, SRC.indexOf('async function downloadHeXLSX', i));
  assert.match(fn, /v == null \? '—'/, 'brl(null) tem de virar —');

  // ⚠️ O escopo é a LINHA, não a função. No KPI o `r.valor_total || 0` é
  // correto — soma de nenhuma linha é zero de verdade. O que não pode é a
  // linha de uma equipe sem cadastro exibir R$ 0,00 como se nada fosse devido.
  const ini = fn.indexOf('const corpo = linhas.map');
  const linha = fn.slice(ini, fn.indexOf(".join('')", ini));
  assert.ok(ini > -1 && linha.length > 100, 'não achei o template da linha');
  assert.match(linha, /brl\(l\.valor_total\)/, 'a linha passa o valor cru pro brl()');
  assert.doesNotMatch(linha, /l\.valor_total \|\| 0/, 'valor por linha não pode cair pra 0');
  assert.doesNotMatch(linha, /l\.valor_hora \|\| 0/);
});

test('a sub-aba é lazy — não custa a quem só quer as sessões', () => {
  const i = SRC.indexOf("} else if (name === 'he') {");
  assert.ok(i > -1, 'não achei o ramo da sub-aba HE');
  assert.match(SRC.slice(i, i + 500), /if \(!_heCache\) loadHeMedicao\(\)/);
});

test('a sub-aba existe e some ao trocar pra outra', () => {
  assert.match(SRC, /id="hist-subtab-he"[^>]*onclick="switchHistSubtab\('he'\)"/);
  assert.match(SRC, /id="hist-he-content"/);
  const i = SRC.indexOf('function switchHistSubtab');
  const bloco = SRC.slice(i, i + 900);
  assert.match(bloco, /if \(hePanel\) hePanel\.style\.display = 'none'/,
    'sem isto o painel HE fica visível junto com as sessões');
});

// ─────────────────────────────────────────────────────────────────────────────
// A rota
// ─────────────────────────────────────────────────────────────────────────────

test('a rota usa req.scope, nunca a regional crua da query', () => {
  const i = ROTAS.indexOf("router.get('/he/medicao'");
  assert.ok(i > -1, 'não achei a rota');
  const bloco = ROTAS.slice(i, i + 1500);
  assert.match(bloco, /req\.scope\.regionals/);
  assert.doesNotMatch(bloco, /req\.query\.regionals/,
    'ler a regional da query burlaria o escopo do token');
});

test('a rota tem teto de período', () => {
  // A medição varre snapshots do intervalo inteiro; sem teto, um range aberto
  // derruba a VM de 3,8GB.
  const i = ROTAS.indexOf("router.get('/he/medicao'");
  const bloco = ROTAS.slice(i, i + 1500);
  assert.match(bloco, /MAX_DIAS = 93/);
  assert.match(bloco, /status\(400\)/);
});

test("'ALL' do multi-select não vira sigla literal", () => {
  const i = ROTAS.indexOf("router.get('/he/medicao'");
  assert.match(ROTAS.slice(i, i + 1500), /_semAll/);
});

// ─────────────────────────────────────────────────────────────────────────────
// O total não pode se passar por fato — reportado na 1ª abertura, 09/09/2026
// ─────────────────────────────────────────────────────────────────────────────

test('sem nenhuma linha com valor, o KPI mostra travessão, não R$ 0,00', () => {
  // Aconteceu de verdade: 640 linhas, cadastro HE ausente, e o cartão exibiu
  // "R$ 0,00" — que se lê como "nada a cobrar" quando a verdade é "não sei".
  const i = SRC.indexOf('_heValorConfiavel');
  assert.ok(i > -1, 'não achei o guarda do valor total');
  const j = SRC.indexOf('desloc-kpi-label">Valor total');
  const bloco = SRC.slice(j, j + 1200);
  assert.match(bloco, /r\.linhas_com_valor === 0 \? '—'/);
  assert.match(bloco, /falta cadastro/);
});

test('total parcial se identifica como parcial', () => {
  const j = SRC.indexOf('desloc-kpi-label">Valor total');
  assert.match(SRC.slice(j, j + 1200), /parcial · \$\{r\.linhas_sem_valor\}/);
});

test('_heValorConfiavel exige TODAS as linhas com valor', () => {
  const i = SRC.indexOf('function _heValorConfiavel');
  assert.match(SRC.slice(i, i + 300), /r\.linhas > 0 && !r\.linhas_sem_valor/);
});

test('o KPI de horas separa antecipação de prorrogação', () => {
  // A Fase 4 precisa isolar a divergência prevista: a planilha atual zera a
  // antecipação e o sistema mede.
  const i = SRC.indexOf('desloc-kpi-label">Total de horas');
  const bloco = SRC.slice(i, i + 600);
  assert.match(bloco, /total_antecipacao_h/);
  assert.match(bloco, /total_prorrogacao_h/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Layout da tabela — reportado em 09/09/2026
// ─────────────────────────────────────────────────────────────────────────────

test('os botões do cabeçalho NÃO usam float', () => {
  // `float:right` + container com `overflow:auto` = o container é um bloco de
  // formatação novo e ENCOLHE pra desviar do float. É regra do CSS, não bug do
  // navegador, e custava ~350px de largura da tabela.
  const i = SRC.indexOf('<h3 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">');
  assert.ok(i > -1, 'o cabeçalho da Medição HE tem de ser flex');
  const bloco = SRC.slice(i, i + 900);
  assert.match(bloco, /id="btn-he-xlsx"/);
  assert.doesNotMatch(bloco, /float:\s*right/, 'float aqui estrangula a tabela');
  assert.match(bloco, /margin-left:auto/, 'os botões vão pra direita sem float');
});

test('nenhum float:right sobrou em atributo de estilo', () => {
  // Os dois únicos do projeto eram os botões da Medição HE. Se voltarem, volta
  // o mesmo defeito.
  //
  // A regex casa só DENTRO de style="…": a 1ª versão contava ocorrências no
  // arquivo inteiro e acusava o próprio comentário que explica o defeito. O
  // comentário fica (é arqueologia datada); o teste é que estava largo.
  const emEstilo = SRC.match(/style="[^"]*float:\s*right/g) || [];
  assert.deepEqual(emEstilo, []);
});

test('o cabeçalho da tabela HE é fixo ao rolar', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const i = CSS.indexOf('.he-tbl thead th');
  assert.ok(i > -1, 'não achei a regra do cabeçalho fixo');
  const regra = CSS.slice(i, CSS.indexOf('}', i));
  assert.match(regra, /position:\s*sticky/);
  assert.match(regra, /top:\s*0/);
  // Fundo opaco: transparente deixaria as linhas passarem POR BAIXO do
  // cabeçalho durante a rolagem.
  assert.match(regra, /background:\s*var\(--cinza1\)/);
  assert.match(SRC, /class="desloc-tbl he-tbl"/, 'a classe tem de estar na tabela');
});

test('a altura da tabela acompanha a tela', () => {
  assert.match(SRC, /max-height:min\(72vh, 700px\)/);
});
