/**
 * test/cadeiaContaEnv.test.js  (P2-37)
 *
 * Hoje `DESG/DESC/DEPT` têm cadeia de UMA conta (`['es']`): se a `es` trava — e o
 * P1-25 diz que outro projeto da empresa, usando a MESMA conta nos MESMOS
 * setores, pode travá-la sozinho — três regionais param juntas, sem backup.
 *
 * O GQO mediu em 17/08/2026 que as duas contas veem os MESMOS 4 setores e as
 * mesmas equipes, e devolvem resultado IDÊNTICO em details/optimized,
 * notes/executed, notes/rejected, break, historic e completeInterruptions:
 * "nenhuma assimetria de permissão foi reproduzida". Nossa própria medição do
 * catálogo de turnos (692 linhas = 4 × os mesmos 173) é a terceira evidência.
 *
 * Então a cadeia do ES PODE ganhar uma conta de último recurso. Mas ligar isso
 * exige 1 probe em produção, que não dá pra fazer daqui — e ativar no escuro
 * mandaria requisição de um setor pra uma conta que talvez não o veja.
 *
 * Solução: a cadeia passa a ser configurável por env. Ativar depois do probe é
 * mudança de `.env` + restart, não deploy de código. O default não muda nada.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const wpa = require('../services/wpaService');

const LIMPAR = ['SECTOR_ACCOUNT_CHAIN_DESG', 'SECTOR_ACCOUNT_CHAIN_DSSJ', 'SECTOR_ACCOUNT_CHAIN_DESC'];
beforeEach(() => { for (const k of LIMPAR) delete process.env[k]; });

describe('_parseChainEnv — só nomes de conta que existem', () => {
  test('lista simples', () => {
    assert.deepEqual(wpa._parseChainEnv('es,sp2'), ['es', 'sp2']);
  });

  test('espaço e caixa não atrapalham', () => {
    assert.deepEqual(wpa._parseChainEnv(' ES , sp2 '), ['es', 'sp2']);
  });

  test('conta inexistente é ignorada', () => {
    assert.deepEqual(wpa._parseChainEnv('es,naoexiste'), ['es']);
  });

  test('duplicata é colapsada, ordem preservada', () => {
    assert.deepEqual(wpa._parseChainEnv('sp2,es,sp2'), ['sp2', 'es']);
  });

  test('vazio, nulo ou só lixo → null (usa o default, nunca deixa setor sem conta)', () => {
    assert.equal(wpa._parseChainEnv(''), null);
    assert.equal(wpa._parseChainEnv(null), null);
    assert.equal(wpa._parseChainEnv('   '), null);
    assert.equal(wpa._parseChainEnv('naoexiste,outra'), null);
  });
});

describe('_accountsForSector respeita o override do env', () => {
  test('sem env, o default de sempre', () => {
    assert.deepEqual(wpa._accountsForSector('DESG'), ['es']);
    assert.deepEqual(wpa._accountsForSector('DSSJ'), ['sp', 'sp2']);
  });

  test('com env, o ES ganha conta de último recurso', () => {
    process.env.SECTOR_ACCOUNT_CHAIN_DESG = 'es,sp2';
    assert.deepEqual(wpa._accountsForSector('DESG'), ['es', 'sp2']);
  });

  test('override de um setor não afeta os outros', () => {
    process.env.SECTOR_ACCOUNT_CHAIN_DESG = 'es,sp2';
    assert.deepEqual(wpa._accountsForSector('DESC'), ['es']);
    assert.deepEqual(wpa._accountsForSector('DSSJ'), ['sp', 'sp2']);
  });

  test('env com lixo é ignorado e o default vale — setor nunca fica órfão', () => {
    process.env.SECTOR_ACCOUNT_CHAIN_DESG = 'contaqueninguemtem';
    assert.deepEqual(wpa._accountsForSector('DESG'), ['es']);
  });

  test('a ordem do env é respeitada: primeira é a primária', () => {
    process.env.SECTOR_ACCOUNT_CHAIN_DESG = 'sp2,es';
    assert.deepEqual(wpa._accountsForSector('DESG'), ['sp2', 'es']);
  });
});
