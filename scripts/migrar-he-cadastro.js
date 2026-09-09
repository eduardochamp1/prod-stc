#!/usr/bin/env node
/**
 * scripts/migrar-he-cadastro.js
 *
 * FASE 1 da SPEC-medicao-he-2026-09-09: cadastro HE por equipe.
 *
 * O que faz:
 *   1. ALTER TABLE equipes_oficiais — adiciona cidade, tipo_breve, servico,
 *      turno_cadastro e he_revisado. Só ADICIONA colunas nulas: nenhuma coluna
 *      existente muda, nenhum dado operacional é reescrito.
 *   2. Grava os valores/hora em app_settings sob `he-valores-hora`.
 *   3. Aplica o seed de db/heCadastroSeed.js com he_revisado = FALSE.
 *
 * ⚠️ O seed é TRANSCRIÇÃO DE PRINT (ver o cabeçalho do heCadastroSeed.js).
 * Toda linha entra como NÃO REVISADA de propósito. A tela de Medição HE avisa
 * enquanto houver equipe não revisada no período — o número não sai do painel
 * se passando por conferido.
 *
 * MODO PADRÃO É DRY-RUN. Nada é escrito sem `--apply`.
 *
 *   node scripts/migrar-he-cadastro.js               # dry-run (default)
 *   node scripts/migrar-he-cadastro.js --csv         # cospe o seed em CSV
 *   node scripts/migrar-he-cadastro.js --apply       # escreve
 *   node scripts/migrar-he-cadastro.js --apply --so-schema   # só as colunas
 *
 * O `--csv` existe pra conferência: cole no Excel ao lado da aba DADOS e
 * compare coluna a coluna. É o caminho mais rápido pra validar a transcrição
 * antes de ela virar fatura.
 */

'use strict';

require('dotenv').config();

const { _getPool } = require('../services/pgShim');
const {
  VALORES_HORA_SEED, seedResolvido, validarCadastroHe, TIPOS_BREVE,
} = require('../db/heCadastroSeed');

const APPLY      = process.argv.includes('--apply');
const CSV        = process.argv.includes('--csv');
const SO_SCHEMA  = process.argv.includes('--so-schema');

const DDL = `
  ALTER TABLE public.equipes_oficiais
    ADD COLUMN IF NOT EXISTS cidade          text,
    ADD COLUMN IF NOT EXISTS tipo_breve      text,
    ADD COLUMN IF NOT EXISTS servico         text,
    ADD COLUMN IF NOT EXISTS turno_cadastro  text,
    ADD COLUMN IF NOT EXISTS he_revisado     boolean NOT NULL DEFAULT false;
`;

function emitirCSV(linhas) {
  console.log('sigla;cidade;tipo_planilha;tipo_breve;turno;servico;conferido;divergencia');
  for (const l of linhas) {
    console.log([
      l.sigla, l.cidade, l.tipo_planilha, l.tipo_breve, l.turno, l.servico,
      l.conferido ? 'SIM' : 'NAO', l.divergencia || '',
    ].join(';'));
  }
}

async function main() {
  const linhas = seedResolvido();

  // ── Validação ANTES de tocar no banco ─────────────────────────────────────
  const invalidas = [];
  for (const l of linhas) {
    const erros = validarCadastroHe(l);
    if (erros.length) invalidas.push({ sigla: l.sigla, erros });
  }
  if (invalidas.length) {
    console.error('✖ seed inválido — nada foi escrito:');
    for (const i of invalidas) console.error(`  ${i.sigla}: ${i.erros.join('; ')}`);
    process.exit(1);
  }

  const semValor = linhas.filter(l => VALORES_HORA_SEED[l.tipo_breve] == null);
  if (semValor.length) {
    console.error(`✖ ${semValor.length} equipe(s) com tipo_breve sem valor/hora: `
      + semValor.map(l => `${l.sigla}=${l.tipo_breve}`).join(', '));
    process.exit(1);
  }

  if (CSV) { emitirCSV(linhas); return; }

  // ── Resumo ────────────────────────────────────────────────────────────────
  const porTipo = {};
  for (const l of linhas) porTipo[l.tipo_breve] = (porTipo[l.tipo_breve] || 0) + 1;
  const conferidas  = linhas.filter(l => l.conferido).length;
  const divergentes = linhas.filter(l => l.divergencia);

  console.log(`\n${linhas.length} equipe(s) no seed.`);
  console.log('  por tipo:', Object.entries(porTipo).map(([t, n]) => `${t}=${n}`).join(' '));
  console.log(`  cruzadas com o valor/hora da aba de medição: ${conferidas}`);
  console.log(`  SEM cruzamento (precisam de revisão humana): ${linhas.length - conferidas}`);
  if (divergentes.length) {
    console.log(`\n⚠️  ${divergentes.length} divergência(s) anotada(s) na transcrição:`);
    for (const d of divergentes) console.log(`  ${d.sigla}: ${d.divergencia}`);
  }
  console.log('\nvalores/hora:', Object.entries(VALORES_HORA_SEED)
    .map(([t, v]) => `${t}=R$${v.toFixed(2)}`).join(' '));

  if (!APPLY) {
    console.log('\n── DRY-RUN. Nada foi escrito. Use --apply pra valer. ──');
    console.log('   Antes disso, rode com --csv e confira contra a aba DADOS.\n');
    return;
  }

  const pool = _getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('\n→ schema…');
    await client.query(DDL);
    console.log('  colunas ok (cidade, tipo_breve, servico, turno_cadastro, he_revisado)');

    if (SO_SCHEMA) {
      await client.query('COMMIT');
      console.log('\n✔ só o schema, como pedido. Seed não aplicado.\n');
      return;
    }

    console.log('→ cadastro por equipe…');
    let atualizadas = 0;
    const ausentes = [];
    for (const l of linhas) {
      // ⚠️ Só ATUALIZA equipe que já existe. Criar equipe a partir de
      // transcrição de print entraria na whitelist e passaria a contar em
      // TODAS as métricas do painel — muito além do escopo da medição.
      const { rowCount } = await client.query(
        `UPDATE public.equipes_oficiais
            SET cidade = $2, tipo_breve = $3, servico = $4,
                turno_cadastro = $5, he_revisado = false, updated_at = now()
          WHERE upper(btrim(sigla)) = $1`,
        [l.sigla, l.cidade, l.tipo_breve, l.servico, l.turno]);
      if (rowCount > 0) atualizadas++;
      else ausentes.push(l.sigla);
    }
    console.log(`  ${atualizadas} atualizada(s), todas com he_revisado = false`);
    if (ausentes.length) {
      console.log(`\n⚠️  ${ausentes.length} sigla(s) do seed NÃO existem em equipes_oficiais:`);
      console.log('   ' + ausentes.join(', '));
      console.log('   Não foram criadas de propósito — cadastrar pelo Admin se forem reais.');
    }

    const { rows: pend } = await client.query(
      `SELECT count(*)::int AS n FROM public.equipes_oficiais
        WHERE ativo AND tipo_breve IS NULL`);
    if (pend[0].n > 0) {
      console.log(`\n⚠️  ${pend[0].n} equipe(s) ativa(s) seguem SEM cadastro HE.`);
      console.log('   A medição vai listar as horas delas com valor vazio, não com zero.');
    }

    await client.query('COMMIT');
    console.log('\n✔ cadastro aplicado.');

    // ⚠️ FORA da transação do cadastro, de propósito.
    //
    // Na 1ª versão este INSERT estava DENTRO dela e usava a coluna `value`,
    // que não existe (a coluna é `data` — ver schema-atual.sql:29). O erro
    // derrubava a transação inteira e levava o cadastro das 45 equipes com
    // ele: o trabalho valioso se perdia por causa da semente de preço.
    // Agora a semente é um passo separado, e falhar aqui é ruído, não perda.
    try {
      await client.query(
        `INSERT INTO public.app_settings (key, data, updated_at)
              VALUES ('he-valores-hora', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE
              SET data = EXCLUDED.data, updated_at = now()`,
        [JSON.stringify(VALORES_HORA_SEED)]);
      console.log('✔ valores/hora semeados em app_settings.');
    } catch (e) {
      console.error('\n⚠️  cadastro OK, mas a semente de valores/hora falhou:');
      console.error(`   ${e.message}`);
      console.error('   O cadastro está salvo. Preencha os valores em Admin → '
        + 'Valores/hora (HE) — a medição avisa enquanto vierem do seed.');
    }

    console.log('\n  PRÓXIMO PASSO: revisar o cadastro no Admin. Enquanto');
    console.log('  he_revisado = false, a tela de Medição HE avisa.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✖ rollback:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
