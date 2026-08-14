/**
 * test/accountDisabled.test.js
 *
 * Kill-switch de conta WPA (WPA_ACCOUNTS_DISABLED), criado em 13/08/2026: a conta
 * do Ismael (sp/SJC) teve a senha errada várias vezes e travou; o operador quer
 * PARAR de extrair dessa conta até resolver, sem NENHUMA tentativa de login (nem
 * a 1 por 12h do breaker), pra não re-travar.
 *
 * Enquanto desativada: getTeamsBySector devolve [] sem tocar na rede e login()
 * recusa. `opts.force` fura o kill-switch (escape-hatch manual).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const wpa = require('../services/wpaService');

beforeEach(() => { wpa._disabledAccounts.clear(); });

test('isAccountDisabled reflete o set (case-insensitive)', () => {
  assert.equal(wpa.isAccountDisabled('sp'), false);
  wpa._disabledAccounts.add('sp');
  assert.equal(wpa.isAccountDisabled('sp'), true);
  assert.equal(wpa.isAccountDisabled('SP'), true, 'case-insensitive');
  assert.equal(wpa.isAccountDisabled('es'), false, 'só a conta listada');
});

test('getTeamsBySector de setor da conta desativada devolve [] SEM rede', async () => {
  wpa._disabledAccounts.add('sp');
  // DSSJ → conta sp (SECTOR_TO_ACCOUNT). Se tentasse rede, falharia por credencial
  // ausente no ambiente de teste; devolver [] limpo prova que nem tentou.
  const teams = await wpa.getTeamsBySector('DSSJ');
  assert.deepEqual(teams, []);
});

test('login() de conta desativada rejeita com isAccountDisabled, sem /signin', async () => {
  wpa._disabledAccounts.add('sp');
  await assert.rejects(
    () => wpa.login({ account: 'sp' }),
    (err) => {
      assert.equal(err.isAccountDisabled, true);
      assert.match(err.message, /DESATIVADO/);
      return true;
    });
});

test('opts.force fura o kill-switch (não rejeita por isAccountDisabled)', async () => {
  wpa._disabledAccounts.add('sp');
  // Com force, pula o guard de desativação; segue e falha adiante (credencial
  // ausente no teste) — o que importa é NÃO ser o erro de desativação.
  await assert.rejects(
    () => wpa.login({ account: 'sp', force: true }),
    (err) => {
      assert.notEqual(err.isAccountDisabled, true, 'force ignorou a desativação');
      return true;
    });
});

test('desativar sp NÃO afeta es (isolamento por conta)', () => {
  wpa._disabledAccounts.add('sp');
  assert.equal(wpa.isAccountDisabled('sp'), true);
  assert.equal(wpa.isAccountDisabled('es'), false);
});
