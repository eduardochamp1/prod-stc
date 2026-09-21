/**
 * scripts/migrar-usuarios.js — move o AUTH_USERS do .env para a tabela.
 *
 * ⚠️ COPIA OS HASHES, nunca senhas. As senhas em texto puro não existem em
 * lugar nenhum — o .env só guarda hashes, e o _verifyPassword já aceita os dois
 * formatos. Ninguém precisa saber a senha de ninguém, e ninguém perde acesso.
 *
 * COMO USAR (na VM):
 *   node scripts/migrar-usuarios.js --gestor=jose --dry-run   # confere
 *   node scripts/migrar-usuarios.js --gestor=jose             # grava
 *
 * `--gestor` é OBRIGATÓRIO: alguém precisa sair da migração podendo gerenciar,
 * senão a tela nasce inútil — ninguém pode criar ninguém, e o único caminho de
 * volta é editar o banco à mão, que é o problema que isto existe pra acabar.
 *
 * Idempotente: rodar duas vezes não duplica nem sobrescreve senha.
 *
 * ⚠️ Rodar ANTES de reduzir o .env. A ordem inteira está na §8 da
 * docs/handoff/SPEC-gestao-usuarios-2026-09-21.md — ela é desenhada pra não
 * existir janela em que alguém legítimo fica sem entrar.
 */

'use strict';

/**
 * Parte PURA: decide o que inserir. Sem banco, sem I/O — é o que o teste cobre.
 *
 * @param authUsers  o conteúdo cru do AUTH_USERS
 * @param gestor     username que sai com pode_gerenciar
 * @param jaNoBanco  [{ username }] dos que já existem
 */
function planejarMigracao(authUsers, gestor, jaNoBanco) {
  const erros = [], inserir = [], pulados = [];
  const existentes = new Set((jaNoBanco || []).map(u => u.username));

  const entradas = String(authUsers || '').split(',').map(s => s.trim()).filter(Boolean);
  if (entradas.length === 0) {
    erros.push('AUTH_USERS está vazio — nada a migrar. Confira o .env.');
    return { erros, inserir, pulados };
  }

  const parsed = entradas.map(e => {
    const [username, senha_hash, role, regionals] = e.split(':');
    return { username, senha_hash, role: role || 'user', regionals: regionals || '' };
  });

  if (!gestor) {
    erros.push('--gestor=<username> é obrigatório: alguém precisa sair da migração '
      + 'podendo gerenciar usuários, senão a tela nasce inútil.');
    return { erros, inserir, pulados };
  }
  const oGestor = parsed.find(u => u.username === gestor);
  if (!oGestor) {
    erros.push(`--gestor="${gestor}" não está no AUTH_USERS. Presentes: `
      + parsed.map(u => u.username).join(', '));
    return { erros, inserir, pulados };
  }
  if (oGestor.role !== 'admin') {
    erros.push(`--gestor="${gestor}" não é admin. O gestor inicial tem de ser admin.`);
    return { erros, inserir, pulados };
  }

  parsed.forEach(u => {
    if (existentes.has(u.username)) { pulados.push(u.username); return; }
    inserir.push({
      username:       u.username,
      senha_hash:     u.senha_hash,     // IDÊNTICO ao do .env — não re-hasheia
      role:           u.role,
      regionals:      u.regionals,
      ativo:          true,
      pode_gerenciar: u.username === gestor,
      criado_por:     'migracao',
    });
  });

  return { erros, inserir, pulados };
}

async function main() {
  require('dotenv').config();
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const gestor = (args.find(a => a.startsWith('--gestor=')) || '').split('=')[1] || null;

  const { getClient } = require('../services/dbClient');
  const sb = getClient();

  const { data: jaNoBanco, error } = await sb.from('usuarios').select('username');
  if (error) {
    console.error('✗ não consegui ler a tabela usuarios:', error.message);
    console.error('  A migration foi aplicada? psql -d wpa_monitor -f migrations/add_usuarios.sql');
    process.exit(1);
  }

  const plano = planejarMigracao(process.env.AUTH_USERS, gestor, jaNoBanco || []);

  if (plano.erros.length) {
    plano.erros.forEach(e => console.error('✗', e));
    process.exit(1);
  }

  console.log(`\nA inserir (${plano.inserir.length}):`);
  plano.inserir.forEach(u => console.log(
    `  ${u.username.padEnd(16)} role=${u.role.padEnd(5)} `
    + `regionals=${u.regionals.padEnd(14)} gerencia=${u.pode_gerenciar}`));
  if (plano.pulados.length) {
    console.log(`\nJá no banco, pulados (${plano.pulados.length}): ${plano.pulados.join(', ')}`);
  }

  if (dryRun) { console.log('\n--dry-run: nada foi gravado.\n'); return; }
  if (plano.inserir.length === 0) { console.log('\nNada a inserir.\n'); return; }

  const { error: insErr } = await sb.from('usuarios').insert(plano.inserir);
  if (insErr) { console.error('✗ falha ao inserir:', insErr.message); process.exit(1); }

  console.log(`\n✓ ${plano.inserir.length} usuário(s) migrado(s).`);
  console.log('  PRÓXIMO PASSO: confira o login de CADA conta antes de limpar o .env.');
  console.log('  Ver seção 8 da SPEC-gestao-usuarios-2026-09-21.md\n');
}

if (require.main === module) {
  main().catch(err => { console.error('✗', err.message); process.exit(1); });
}

module.exports = { planejarMigracao };
