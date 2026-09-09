/**
 * test/htmlScriptSintaxe.test.js
 *
 * O JS embutido em public/index.html COMPILA?
 *
 * ── POR QUE ISTO EXISTE (incidente 09/09/2026) ──────────────────────────────
 * Eu escrevi um comentário HTML explicativo DENTRO de um template literal e
 * usei crases pra destacar o nome de uma propriedade CSS. A crase fechou a
 * string, o parser encontrou `float:right` como código, e o resultado foi:
 *
 *     Uncaught SyntaxError: Unexpected identifier 'float'   (índice):5573
 *     Uncaught ReferenceError: switchTab is not defined
 *
 * Um erro de sintaxe derruba o SCRIPT INTEIRO, não a função onde está. O
 * painel subiu em produção com TODAS as abas mortas — nenhum KPI, nenhuma
 * equipe, nada. E a suíte estava 919/919 verde, porque todos os ~250 testes
 * de frontend leem o index.html como TEXTO e nenhum tentava compilá-lo.
 *
 * Era o buraco mais óbvio da suíte num arquivo de 9 mil linhas (risco H11 do
 * backlog): 250 testes conferindo o conteúdo de um script que ninguém checava
 * se roda.
 *
 * Limite explícito: isto prova que COMPILA, não que funciona. Erro de runtime,
 * seletor errado ou lógica trocada continuam passando.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ARQUIVO = path.join(__dirname, '..', 'public', 'index.html');
const SRC = fs.readFileSync(ARQUIVO, 'utf8');

/**
 * Blocos `<script>` INLINE (sem src). O `src` aponta pro vendor, que não é
 * nosso e já vem minificado.
 */
function blocosInline() {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(SRC)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue;
    // Linha onde o bloco começa, pra a mensagem de erro ser útil.
    const linha = SRC.slice(0, m.index).split('\n').length;
    out.push({ codigo: m[2], linha, attrs });
  }
  return out;
}

test('existe JS inline pra checar', () => {
  const b = blocosInline();
  assert.ok(b.length > 0, 'nenhum <script> inline encontrado — o regex quebrou?');
  // O painel é um monólito: o bloco principal tem milhares de linhas.
  assert.ok(b.some(x => x.codigo.length > 100000),
    'esperava o bloco principal do painel; achei só fragmentos');
});

test('TODO bloco <script> inline compila', () => {
  for (const { codigo, linha } of blocosInline()) {
    try {
      // `new vm.Script` faz o parse SEM executar. É exatamente o que o
      // navegador faz antes de rodar, e é o passo que falhava.
      new vm.Script(codigo, { filename: `public/index.html:${linha}` });
    } catch (err) {
      assert.fail(
        `<script> que começa na linha ${linha} de public/index.html NÃO COMPILA:\n`
        + `  ${err.message}\n`
        + '  Suspeitos frequentes: crase dentro de template literal (foi o de\n'
        + '  09/09/2026), ${ } não fechado, ou aspas desbalanceadas.');
    }
  }
});

test('nenhuma crase em comentário HTML DENTRO de script', () => {
  // Defesa específica pro erro de 09/09/2026: comentário HTML é a única prosa
  // longa que vive dentro de template literal, e é onde dá vontade de marcar
  // um nome de propriedade com crase.
  //
  // ⚠️ O escopo é o que está DENTRO de <script>. A 1ª versão varria o arquivo
  // inteiro e reprovou num comentário do HTML estático que tem crase e é
  // perfeitamente válido lá — comentário fora de script é só texto pro
  // navegador. Regra larga demais reprova código correto e ensina a ignorar
  // o teste.
  const culpados = [];
  for (const { codigo, linha } of blocosInline()) {
    for (const c of (codigo.match(/<!--[\s\S]*?-->/g) || [])) {
      if (c.includes('`')) culpados.push(`linha ~${linha}: ${c.slice(0, 70)}`);
    }
  }
  assert.deepEqual(culpados, [],
    'comentário HTML com crase dentro de <script>: se estiver num template '
    + 'literal, fecha a string e derruba o script inteiro');
});

test('nenhum caractere de controle solto no arquivo', () => {
  // Já mordeu este projeto em edição por sed: um byte de controle no meio
  // quebra o parse com mensagem que não ajuda em nada.
  //
  // ⚠️ O BOM do INÍCIO do arquivo é tolerado de propósito: ele está lá desde o
  // P2-3 (`b8113d3`, quando o index.html foi pro public/) e o navegador aceita
  // BOM em HTML — é sinal de codificação, não lixo. A 1ª versão deste teste
  // reprovava por causa dele e apontava um problema que não existe.
  const controle = SRC.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  assert.equal(controle, null,
    `caractere de controle 0x${controle ? controle[0].charCodeAt(0).toString(16) : ''} no arquivo`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TODO arquivo de scripts/ compila
//
// ── POR QUE ISTO EXISTE (2ª vez no mesmo dia, 09/09/2026) ───────────────────
// Depois do incidente da crase no index.html, cometi o MESMO erro num
// comentário SQL dentro de um template literal em
// `scripts/diag-he-sessoes-abertas.js`. A suíte passou 962/962 verde porque:
//   • o teste acima só olha public/index.html;
//   • `node --test` carrega db/, services/ e routes/ por `require`, então erro
//     de sintaxe lá quebra algum teste — mas NINGUÉM importa scripts/.
// Os scripts são justamente o que roda direto em produção, à mão, com o dedo
// do operador. Eram o único diretório de JS sem nenhuma verificação.
// ─────────────────────────────────────────────────────────────────────────────

const DIR_SCRIPTS = path.join(__dirname, '..', 'scripts');

test('todo .js de scripts/ compila', () => {
  const arquivos = fs.readdirSync(DIR_SCRIPTS).filter(f => f.endsWith('.js'));
  assert.ok(arquivos.length > 5, `esperava vários scripts, achei ${arquivos.length}`);
  for (const f of arquivos) {
    const codigo = fs.readFileSync(path.join(DIR_SCRIPTS, f), 'utf8');
    try {
      new vm.Script(codigo, { filename: `scripts/${f}` });
    } catch (err) {
      assert.fail(`scripts/${f} NÃO COMPILA:\n  ${err.message}\n`
        + '  Suspeito frequente: crase dentro de template literal — inclusive em\n'
        + '  comentário SQL, que foi o erro de 09/09/2026.');
    }
  }
});

test('nenhum comentário SQL com crase dentro de template literal', () => {
  // Defesa específica: comentário `--` dentro de uma query em template literal
  // é onde a crase reapareceu depois de eu já ter documentado o perigo.
  const culpados = [];
  for (const f of fs.readdirSync(DIR_SCRIPTS).filter(x => x.endsWith('.js'))) {
    const codigo = fs.readFileSync(path.join(DIR_SCRIPTS, f), 'utf8');
    for (const linha of codigo.split('\n')) {
      if (/^\s*--/.test(linha) && linha.includes('`')) culpados.push(`${f}: ${linha.trim()}`);
    }
  }
  assert.deepEqual(culpados, []);
});

test('o BOM não aparece DENTRO de nenhum bloco de script', () => {
  // No meio do JS, aí sim ele quebra o parse. (Cobertura de verdade: o teste de
  // compilação acima pegaria, mas a mensagem aqui é bem mais direta.)
  for (const { codigo, linha } of blocosInline()) {
    assert.equal(codigo.includes('﻿'), false,
      `BOM dentro do <script> da linha ${linha}`);
  }
});
