/**
 * scripts/rehash-users.js — migra AUTH_USERS de SHA-256 pra scrypt (P1-5).
 *
 * O login aceita AMBOS os formatos (compat retroativa), então a migração é
 * opcional e sem downtime. Mas SHA-256 sem salt cai rápido em rainbow table
 * se o .env vazar — scrypt com salt por usuário resolve.
 *
 * COMO USAR (interativo, na VM):
 *   1. Rode:  node scripts/rehash-users.js
 *   2. Pra cada usuário, digite a senha em texto puro quando pedido.
 *      (As senhas NÃO estão no .env — só os hashes. Você precisa sabê-las;
 *       estão no cofre corporativo — ver P0-1 / RUNBOOK.md.)
 *   3. O script imprime a linha AUTH_USERS nova (formato scrypt).
 *   4. Substitua no .env e reinicie:
 *        pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
 *   5. Teste login de cada conta.
 *
 * Alternativa não-interativa (passar senhas por env — cuidado com histórico):
 *   USERS="admin=senha1,guarapari=senha2" node scripts/rehash-users.js
 */

require('dotenv').config();
const readline = require('readline');
const { hashPassword } = require('../middleware/auth');

function parseAuthUsersRaw() {
  const raw = process.env.AUTH_USERS || '';
  return raw.split(',').filter(Boolean).map(entry => {
    const [username, passwordHash, role, regionals] = entry.trim().split(':');
    return { username, passwordHash, role, regionals };
  });
}

function montarLinha(users) {
  return users.map(u => `${u.username}:${u.passwordHash}:${u.role}:${u.regionals}`).join(',');
}

async function main() {
  const users = parseAuthUsersRaw();
  if (users.length === 0) {
    console.error('AUTH_USERS vazio ou não configurado no .env.');
    process.exit(1);
  }

  // Modo não-interativo via USERS="user=senha,..."
  const inline = process.env.USERS;
  if (inline) {
    const senhas = Object.fromEntries(
      inline.split(',').map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; })
    );
    for (const u of users) {
      if (senhas[u.username]) u.passwordHash = hashPassword(senhas[u.username]);
      else console.warn(`⚠️  senha de "${u.username}" não fornecida — mantido hash atual`);
    }
    console.log('\n=== AUTH_USERS (novo) ===\nAUTH_USERS=' + montarLinha(users) + '\n');
    process.exit(0);
  }

  // Modo interativo
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pergunta = (q) => new Promise(r => rl.question(q, r));

  console.log(`Encontrados ${users.length} usuários. Digite a senha de cada (Enter vazio = manter hash atual).\n`);
  for (const u of users) {
    const senha = await pergunta(`Senha de "${u.username}" (${u.role}/${u.regionals}): `);
    if (senha.trim()) u.passwordHash = hashPassword(senha);
    else console.log(`  → mantido hash atual de ${u.username}`);
  }
  rl.close();

  console.log('\n=== Cole esta linha no .env (substitui a AUTH_USERS atual) ===\n');
  console.log('AUTH_USERS=' + montarLinha(users) + '\n');
}

main();
