'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Os scripts de diagnóstico NÃO escrevem.
//
// A convenção está escrita no cabeçalho de cada um ("ESTRITAMENTE READ-ONLY"),
// e até 10/09/2026 nada a verificava — a garantia era eu reler o arquivo. Um
// `--apply` colado por engano num diag escreveria em produção sem passar por
// revisão nenhuma.
//
// ⚠️ A regra vale pro SQL EXECUTADO, não pro arquivo inteiro. A 1ª versão deste
// teste varria o texto e acusou `diag-app-settings.js`, que IMPRIME um
// `DELETE FROM ...` como sugestão pro operador rodar à mão — texto de ajuda,
// não escrita. Foi a 4ª vez no projeto que uma regex negativa larga pegou o
// próprio código explicando o perigo; a saída é sempre escopar no que importa.
// ─────────────────────────────────────────────────────────────────────────────

const DIR = path.join(__dirname, '..', 'scripts');

const ESCRITA =
  /\b(INSERT\s+INTO|UPDATE\s+[a-z_"]|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i;

function diags() {
  return fs.readdirSync(DIR).filter(f => /^diag-.*\.js$/.test(f));
}

test('há scripts de diagnóstico pra verificar', () => {
  // Se o glob parar de casar (renomeação, pasta movida), o teste abaixo passa
  // vazio e a garantia desaparece em silêncio.
  assert.ok(diags().length >= 3, 'esperava vários diag-*.js; achei ' + diags().length);
});

test('todo scripts/diag-*.js executa apenas SELECT', () => {
  for (const f of diags()) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    // Só o SQL passado a `.query(` — o template literal que vem logo depois.
    for (const m of src.matchAll(/\.query\(\s*`([^`]*)`/g)) {
      const achado = m[1].match(ESCRITA);
      assert.equal(achado, null, `${f} executa escrita: ${achado && achado[0]}`);
    }
  }
});

test('nenhum diag escreve pelo shim do supabase', () => {
  // `.upsert()/.insert()/.delete()` não passam por `.query(`, então escapam da
  // verificação de cima.
  for (const f of diags()) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.ok(!/\.upsert\(|\.insert\(|\.delete\(/.test(src), `${f} escreve pelo shim`);
  }
});

test('o diag do retorno à base compara as DUAS leituras de fuso', () => {
  // O ponto do script é decidir em que fuso `sessao_intervalo.inicio` está.
  // Um lado só não decide nada — se alguém simplificar pra uma leitura, o
  // script deixa de responder a pergunta que motivou ele.
  const src = fs.readFileSync(path.join(DIR, 'diag-retorno-base.js'), 'utf8');
  assert.match(src, /AT TIME ZONE 'America\/Sao_Paulo'/);
  assert.match(src, /AT TIME ZONE 'UTC'/);
  // E o oráculo é a refeição, não o próprio "29" (que é o que se quer medir).
  assert.match(src, /ILIKE '%refei%'/);
});

test('o diag do "a mais" usa a MESMA regra do KPI e não chama a EDP', () => {
  // O ponto do script (16/10/2026) é explicar o número da TELA. Se ele
  // reimplementar "esperadas" por conta própria, explica outro número; se ler
  // `teams_current` (dedup por team_name, guarda a última sessão do lote) em vez
  // de `snapshots`, perde a sessão aberta de quem relogou.
  const src = fs.readFileSync(path.join(DIR, 'diag-escala-a-mais.js'), 'utf8');
  assert.match(src, /equipesEsperadasAgora\(null, ref\)/);
  assert.match(src, /FROM public\.snapshots/);
  assert.doesNotMatch(src, /FROM public\.teams_current/);
  // Conta da EDP é compartilhada (P1-25): diag não loga nem coleta.
  assert.doesNotMatch(src, /require\(['"]\.\.\/services\/wpaService['"]\)/);
});

test('o diag da queda do "em campo" lê o ciclo gravado e não chama a EDP', () => {
  // O ponto do script (16/10/2026) é ler a assinatura que o CICLO deixou em
  // `snapshots` (setor ausente × sem V2 × IsOnline). Coletar de novo na EDP
  // mostraria o agora, não o ciclo que caiu — e gastaria a conta (P1-25).
  const src = fs.readFileSync(path.join(DIR, 'diag-ciclo-em-campo.js'), 'utf8');
  assert.match(src, /FROM public\.snapshots/);
  assert.match(src, /v2Presente/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/services\/(wpaService|dataService)['"]\)/);
});
