/**
 * test/alertaProdutividade.test.js
 *
 * Regras PURAS do alerta de baixa produtividade (SPEC-alerta-produtividade-2026-10-14).
 * Nada aqui toca banco, WPA ou relógio: tudo entra por parâmetro.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  meioDoTurno, minutosDeHM, emRefeicao, validarConfig, avaliarEquipe, DEFAULT_CONFIG,
} = require('../services/alertaProdutividade');

const hm = (h, m = 0) => h * 60 + m;

// ── meioDoTurno ──────────────────────────────────────────────────────────────
describe('meioDoTurno', () => {
  test('08:00–17:00 → 12:30', () => {
    assert.equal(meioDoTurno('08:00', '17:00'), hm(12, 30));
  });
  test('aceita HH:MM:SS (formato do TIME do Postgres)', () => {
    assert.equal(meioDoTurno('08:00:00', '17:00:00'), hm(12, 30));
    assert.equal(meioDoTurno('14:00:00', '23:00:00'), hm(18, 30));
  });
  test('turno que atravessa a meia-noite → null (fora da v1)', () => {
    assert.equal(meioDoTurno('22:00', '07:00'), null);
  });
  test('início = fim → null', () => {
    assert.equal(meioDoTurno('08:00', '08:00'), null);
  });
  test('nulo, vazio ou inválido → null', () => {
    assert.equal(meioDoTurno(null, '17:00'), null);
    assert.equal(meioDoTurno('08:00', undefined), null);
    assert.equal(meioDoTurno('', ''), null);
    assert.equal(meioDoTurno('25:00', '26:00'), null);
    assert.equal(meioDoTurno('abc', '17:00'), null);
  });
  test('arredonda para baixo em minuto inteiro', () => {
    assert.equal(meioDoTurno('08:00', '17:01'), hm(12, 30));
  });
});

describe('minutosDeHM', () => {
  test('converte e rejeita lixo', () => {
    assert.equal(minutosDeHM('07:05'), 425);
    assert.equal(minutosDeHM('07:05:59'), 425);
    assert.equal(minutosDeHM('24:00'), null);
    assert.equal(minutosDeHM('7:5'), null);
    assert.equal(minutosDeHM(830), null);
  });
});

// ── emRefeicao ───────────────────────────────────────────────────────────────
describe('emRefeicao', () => {
  test('intervalo EM ABERTO de refeição → true', () => {
    assert.equal(emRefeicao([{ motivo: '15 - Horário de Refeição', emAberto: true }]), true);
    assert.equal(emRefeicao([{ motivo: 'Horário de Refeição', emAberto: true }]), true);
  });
  test('refeição já FECHADA → false', () => {
    assert.equal(emRefeicao([{ motivo: '15 - Horário de Refeição', emAberto: false }]), false);
  });
  test('aberto de outro motivo → false', () => {
    assert.equal(emRefeicao([{ motivo: '29 - Retorno da equipe à base', emAberto: true }]), false);
  });
  test('lista vazia / nula / sem motivo → false', () => {
    assert.equal(emRefeicao([]), false);
    assert.equal(emRefeicao(null), false);
    assert.equal(emRefeicao([{ motivo: null, emAberto: true }]), false);
  });
  test('vale se QUALQUER intervalo da lista for refeição em aberto', () => {
    assert.equal(emRefeicao([
      { motivo: 'Callback', emAberto: false },
      { motivo: '15 - Horário de Refeição', emAberto: true },
    ]), true);
  });
});

// ── validarConfig ────────────────────────────────────────────────────────────
describe('validarConfig', () => {
  test('o padrão nasce DESLIGADO, limite 4, 4 categorias', () => {
    assert.equal(DEFAULT_CONFIG.ativo, false);
    assert.equal(DEFAULT_CONFIG.limite, 4);
    assert.deepEqual(DEFAULT_CONFIG.categorias, ['COMERCIAL', 'PLANTAO', 'MOTO', 'BT_ZERO']);
    assert.equal(DEFAULT_CONFIG.tolerancia_refeicao_min, 60);
  });
  test('ausente / ilegível → desligado e inválido', () => {
    for (const raw of [undefined, null, 'x', 7, []]) {
      const r = validarConfig(raw);
      assert.equal(r.ok, false, JSON.stringify(raw));
      assert.equal(r.config.ativo, false);
    }
  });
  test('config completa e válida passa', () => {
    const r = validarConfig({ ativo: true, limite: 3, categorias: ['COMERCIAL'], tolerancia_refeicao_min: 30 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.config, { ativo: true, limite: 3, categorias: ['COMERCIAL'], tolerancia_refeicao_min: 30 });
  });
  test('campos ausentes usam o padrão (mas ativo ausente = desligado)', () => {
    const r = validarConfig({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.config, DEFAULT_CONFIG);
  });
  test('limite inválido (0, negativo, fracionário, string)', () => {
    for (const limite of [0, -1, 2.5, '4', NaN]) {
      const r = validarConfig({ ativo: true, limite });
      assert.equal(r.ok, false, String(limite));
      assert.equal(r.config.ativo, false, 'inválido NUNCA liga');
    }
  });
  test('categoria inexistente ou lista vazia com ativo', () => {
    assert.equal(validarConfig({ categorias: ['XPTO'] }).ok, false);
    assert.equal(validarConfig({ ativo: true, categorias: [] }).ok, false);
    assert.equal(validarConfig({ categorias: 'COMERCIAL' }).ok, false);
  });
  test('OPERACIONAL é aceita (fora do padrão, mas existe no catálogo)', () => {
    assert.equal(validarConfig({ categorias: ['COMERCIAL', 'OPERACIONAL'] }).ok, true);
  });
  test('ativo precisa ser booleano de verdade', () => {
    assert.equal(validarConfig({ ativo: 'true' }).ok, false);
    assert.equal(validarConfig({ ativo: 1 }).ok, false);
  });
  test('tolerância inválida (negativa, fracionária)', () => {
    assert.equal(validarConfig({ tolerancia_refeicao_min: -5 }).ok, false);
    assert.equal(validarConfig({ tolerancia_refeicao_min: 1.5 }).ok, false);
    assert.equal(validarConfig({ tolerancia_refeicao_min: 0 }).ok, true);
  });
  test('não muta o objeto recebido nem devolve a mesma referência de categorias', () => {
    const raw = { ativo: true, categorias: ['MOTO'] };
    const r = validarConfig(raw);
    assert.notEqual(r.config.categorias, raw.categorias);
    assert.deepEqual(raw, { ativo: true, categorias: ['MOTO'] });
  });
});

// ── avaliarEquipe ────────────────────────────────────────────────────────────
const CFG = { ativo: true, limite: 4, categorias: ['COMERCIAL', 'PLANTAO', 'MOTO', 'BT_ZERO'], tolerancia_refeicao_min: 60 };
const base = (o = {}) => ({
  agoraMin: hm(13, 0),                     // depois do meio (12:30) de um turno 08–17
  config: CFG,
  escala: { inicio: '08:00', fim: '17:00' },
  executadas: 2,
  rejeitadas: 0,
  sessaoAberta: true,
  ehReal: true,
  categoria: 'COMERCIAL',
  aberto: false,
  resolvido: false,
  emRefeicao: false,
  ...o,
});
const estado = (o) => avaliarEquipe(base(o)).estado;

describe('avaliarEquipe — regra principal', () => {
  test('abaixo do limite, depois do meio, fora da refeição → abrir', () => {
    assert.equal(estado(), 'abrir');
  });
  test('limite exato: 3 alerta, 4 não', () => {
    assert.equal(estado({ executadas: 3 }), 'abrir');
    assert.equal(estado({ executadas: 4 }), 'nenhum');
    assert.equal(avaliarEquipe(base({ executadas: 4 })).motivo, 'acima_do_limite');
  });
  test('o limite é configurável', () => {
    const cfg = { ...CFG, limite: 6 };
    assert.equal(estado({ config: cfg, executadas: 5 }), 'abrir');
    assert.equal(estado({ config: cfg, executadas: 6 }), 'nenhum');
  });
  test('zero executadas alerta', () => {
    assert.equal(estado({ executadas: 0 }), 'abrir');
  });
  test('rejeitadas NÃO entram na conta (só contexto)', () => {
    assert.equal(estado({ executadas: 3, rejeitadas: 9 }), 'abrir');
  });
});

describe('avaliarEquipe — janela do turno', () => {
  test('antes do meio do turno → nenhum', () => {
    const r = avaliarEquipe(base({ agoraMin: hm(12, 29) }));
    assert.equal(r.estado, 'nenhum');
    assert.equal(r.motivo, 'antes_do_meio');
  });
  test('exatamente no meio já avalia', () => {
    assert.equal(estado({ agoraMin: hm(12, 30) }), 'abrir');
  });
  test('no fim do turno ou depois → nenhum', () => {
    assert.equal(estado({ agoraMin: hm(17, 0) }), 'nenhum');
    assert.equal(avaliarEquipe(base({ agoraMin: hm(17, 1) })).motivo, 'apos_fim');
  });
  test('Plantão 14–23: meio às 18:30', () => {
    const e = { inicio: '14:00', fim: '23:00' };
    assert.equal(estado({ escala: e, categoria: 'PLANTAO', agoraMin: hm(18, 29) }), 'nenhum');
    assert.equal(estado({ escala: e, categoria: 'PLANTAO', agoraMin: hm(18, 30) }), 'abrir');
  });
});

describe('avaliarEquipe — escala e elegibilidade', () => {
  test('sem escala → ignorar (contado à parte), nunca inventa horário', () => {
    for (const escala of [{ inicio: null, fim: null }, { inicio: '08:00', fim: null }, null, undefined]) {
      const r = avaliarEquipe(base({ escala }));
      assert.equal(r.estado, 'ignorar');
      assert.equal(r.motivo, 'sem_escala');
    }
  });
  test('turno que atravessa a meia-noite → ignorar (fora da v1)', () => {
    const r = avaliarEquipe(base({ escala: { inicio: '22:00', fim: '07:00' } }));
    assert.equal(r.estado, 'ignorar');
    assert.equal(r.motivo, 'vira_noite');
  });
  test('equipe fantasma (deslogada) NÃO alerta', () => {
    assert.equal(estado({ ehReal: false }), 'nenhum');
  });
  test('sessão encerrada NÃO alerta', () => {
    assert.equal(estado({ sessaoAberta: false }), 'nenhum');
  });
  test('categoria fora da configuração NÃO alerta', () => {
    assert.equal(estado({ categoria: 'OPERACIONAL' }), 'nenhum');
    assert.equal(estado({ config: { ...CFG, categorias: ['COMERCIAL'] }, categoria: 'MOTO' }), 'nenhum');
  });
  test('desligado → nenhum, sem avaliar mais nada', () => {
    const r = avaliarEquipe(base({ config: { ...CFG, ativo: false } }));
    assert.equal(r.estado, 'nenhum');
    assert.equal(r.motivo, 'desligado');
  });
});

describe('avaliarEquipe — refeição', () => {
  test('em refeição, dentro da tolerância → adiar', () => {
    assert.equal(avaliarEquipe(base({ emRefeicao: true, agoraMin: hm(13, 0) })).estado, 'adiar');
  });
  test('em refeição mas passou meio + tolerância → abre mesmo assim', () => {
    // meio 12:30 + 60min = 13:30
    assert.equal(estado({ emRefeicao: true, agoraMin: hm(13, 29) }), 'adiar');
    assert.equal(estado({ emRefeicao: true, agoraMin: hm(13, 30) }), 'abrir');
  });
  test('tolerância 0 → nunca adia', () => {
    assert.equal(estado({ emRefeicao: true, config: { ...CFG, tolerancia_refeicao_min: 0 } }), 'abrir');
  });
  test('consulta de refeição falhou/não feita (null) → adiar, NUNCA alerta sem a informação', () => {
    const r = avaliarEquipe(base({ emRefeicao: null }));
    assert.equal(r.estado, 'adiar');
    assert.equal(r.motivo, 'refeicao_indisponivel');
  });
  test('refeição só importa para quem ia alertar', () => {
    assert.equal(estado({ emRefeicao: true, executadas: 5 }), 'nenhum');
    assert.equal(estado({ emRefeicao: null, executadas: 5 }), 'nenhum');
  });
});

describe('avaliarEquipe — ciclo de vida do alerta', () => {
  test('aberto e ainda abaixo do limite → manter', () => {
    assert.equal(estado({ aberto: true, executadas: 2 }), 'manter');
  });
  test('aberto e chegou ao limite → resolver', () => {
    assert.equal(estado({ aberto: true, executadas: 4 }), 'resolver');
    assert.equal(estado({ aberto: true, executadas: 7 }), 'resolver');
  });
  test('aberto resolve mesmo depois do fim do turno', () => {
    assert.equal(estado({ aberto: true, executadas: 4, agoraMin: hm(18, 0) }), 'resolver');
  });
  test('aberto continua sem consultar refeição (a refeição só vale para abrir)', () => {
    assert.equal(estado({ aberto: true, executadas: 2, emRefeicao: null }), 'manter');
  });
  test('resolvido NUNCA reabre, mesmo que as executadas caiam', () => {
    assert.equal(estado({ resolvido: true, executadas: 0 }), 'nenhum');
    assert.equal(avaliarEquipe(base({ resolvido: true, executadas: 0 })).motivo, 'ja_resolvido');
  });
  test('executadas que CAEM depois do disparo mantêm o aberto aberto', () => {
    assert.equal(estado({ aberto: true, executadas: 1 }), 'manter');
  });
  test('o resultado sempre traz estado e motivo', () => {
    const r = avaliarEquipe(base());
    assert.equal(typeof r.estado, 'string');
    assert.equal(typeof r.motivo, 'string');
  });
});
