#!/usr/bin/env node
/**
 * scripts/diag-po-reparo-amostra.js
 *
 * READ-ONLY. Não grava nada, em lugar nenhum.
 *
 * Mede, numa AMOSTRA de notas PO, o intervalo entre o "Horário do Reparo" e o
 * checkpoint "Finalizando Trabalho". Critério da operação (José, 29/08/2026):
 * a diferença tem de ser de **no mínimo 10 minutos**; abaixo disso indica
 * problema no método de apontamento da equipe, e esses minutos contam no CHI do
 * CSD atendido.
 *
 * POR QUE MEDIR ANTES DE CONSTRUIR: se a violação for rara, o indicador é uma
 * lista de exceções; se for metade da base, é um gráfico de distribuição e uma
 * conversa diferente com a operação. O desenho da tela depende do número.
 *
 * ── As duas fontes (ver docs/handoff/API-WPA-EDP.md §6.2.2) ──────────────────
 *   Horário do Reparo    → GET /api/notes/po?noteId={uuid}
 *                          Execution.PowerOnExecution.RepairTime
 *   Finalizando Trabalho → GET /api/Notes/{uuid}/details/optimized
 *                          Checkpoints[] com Event === 4, campo RegisteredAt2
 *
 * ⚠️ SÃO DOIS REQUESTS POR NOTA. O checkpoint não sai do cache: o nosso payload
 * guarda `timestamp` derivado de `cp.TimeStamp`, que é o relógio do aparelho no
 * ENVIO — mede errado (nos eventos 0 e 1 chega a errar 55 minutos). O campo
 * certo, `RegisteredAt2`, é descartado no notaProcessor.
 *
 * ⚠️ FUSOS DIFERENTES, e a armadilha é traiçoeira. `RepairTime` vem UTC com
 * `+00:00`; `RegisteredAt` vem local SEM marcador nenhum. Medido com os valores
 * reais da nota 104875481:
 *
 *   TZ=America/Sao_Paulo   RegisteredAt2 → +7,03 min    RegisteredAt → +7,03 min
 *   TZ=UTC   (a VM)        RegisteredAt2 → +7,03 min    RegisteredAt → −172,97 min
 *
 * Ou seja: usar o campo cru FUNCIONA na máquina do dev (BRT) e QUEBRA em
 * produção (UTC), com 3h de erro que ainda inverte o sinal — viraria "reparo
 * apontado 3h depois de terminar o trabalho", que é absurdo plausível o
 * suficiente pra passar por anomalia real em vez de bug.
 *
 * Por isso aqui só `RegisteredAt2` é aceito. Nota sem ele é contada à parte,
 * nunca estimada.
 *
 * USO (na VM):
 *   node -r dotenv/config scripts/diag-po-reparo-amostra.js --limite 200
 *   node -r dotenv/config scripts/diag-po-reparo-amostra.js --limite 500 --de 2026-08-01
 *
 *   Amostra grande (roda em background, ~1,3s por nota):
 *     nohup node -r dotenv/config scripts/diag-po-reparo-amostra.js --limite 1000 \
 *       > /tmp/po-reparo.log 2>&1 &
 *     tail -f /tmp/po-reparo.log
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
}

const LIMITE  = Math.min(Math.max(parseInt(arg('limite', '200'), 10) || 200, 1), 5000);
const DE      = arg('de', null);
const ATE     = arg('ate', null);
const PAUSA   = Math.max(parseInt(arg('pausa', '80'), 10) || 80, 0);   // ms entre notas
const MINIMO  = 10;   // minutos — o critério da operação

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

/** Instante do "Finalizando Trabalho" (evento 4) — só do campo com fuso explícito. */
function finalizandoTrabalho(checkpoints) {
  const quatros = (checkpoints || []).filter(cp => cp && Number(cp.Event) === 4);
  if (quatros.length === 0) return { instante: null, quantos: 0, semFuso: false };

  // Sem RegisteredAt2 não dá pra saber o fuso, e chutar aqui viraria erro de 3h
  // espalhado por milhares de notas. Melhor contar como "não mediu".
  const comFuso = quatros.filter(cp => typeof cp.RegisteredAt2 === 'string' && cp.RegisteredAt2);
  if (comFuso.length === 0) return { instante: null, quantos: quatros.length, semFuso: true };

  // Várias tentativas geram vários event=4. Vale o ÚLTIMO: é o que fecha a
  // execução que terminou na conclusão da nota.
  const ts = comFuso
    .map(cp => new Date(cp.RegisteredAt2).getTime())
    .filter(n => Number.isFinite(n))
    .sort((a, b) => b - a);
  return { instante: ts[0] ?? null, quantos: quatros.length, semFuso: false };
}

function pct(n, total) { return total ? (100 * n / total).toFixed(1) + '%' : '—'; }

function percentil(ordenado, p) {
  if (!ordenado.length) return null;
  const i = Math.min(ordenado.length - 1, Math.floor((p / 100) * ordenado.length));
  return ordenado[i];
}

async function main() {
  const { _getPool } = require('../services/pgShim');
  const { getNoteDetail, wpaFetch } = require('../services/wpaService');
  const pool = _getPool();
  if (!pool) { console.error('Sem pool. Rode com `node -r dotenv/config` na VM.'); process.exit(1); }

  const params = [];
  let where = `tipo = 'PO' AND payload->'checkpoints' IS NOT NULL`;
  if (DE)  { params.push(DE);  where += ` AND fetched_at >= $${params.length}::date`; }
  if (ATE) { params.push(ATE); where += ` AND fetched_at < ($${params.length}::date + interval '1 day')`; }
  params.push(LIMITE);

  const { rows: notas } = await pool.query(
    `SELECT note_id, numero, sector_id, fetched_at
       FROM public.note_details
      WHERE ${where}
      ORDER BY fetched_at DESC
      LIMIT $${params.length}`, params);

  console.log(`\n=== Amostra: ${notas.length} notas PO`
    + `${DE ? ` de ${DE}` : ''}${ATE ? ` até ${ATE}` : ''} ===`);
  console.log(`Critério: Finalizando Trabalho − Horário do Reparo >= ${MINIMO} min\n`);

  const contas = {
    semPowerOn: 0, semRepairTime: 0, hasRepairFalse: 0,
    semEvento4: 0, semFuso: 0, multiplosEv4: 0, erro: 0,
  };
  const deltas = [];        // minutos, só das notas mensuráveis
  const violacoes = [];     // < MINIMO
  const negativos = [];     // reparo DEPOIS do finalizando

  let i = 0;
  for (const n of notas) {
    i++;
    if (i % 25 === 0) process.stdout.write(`  … ${i}/${notas.length}\r`);
    try {
      const r = await wpaFetch(`/api/notes/po?noteId=${encodeURIComponent(n.note_id)}`);
      if (!r.ok) { contas.erro++; continue; }
      const body = await r.json().catch(() => null);
      const d = (body && typeof body === 'object' && 'Data' in body) ? body.Data : body;
      const po = d && d.Execution && d.Execution.PowerOnExecution;
      if (!po) { contas.semPowerOn++; continue; }
      if (po.HasRepair === false) { contas.hasRepairFalse++; continue; }
      if (!po.RepairTime) { contas.semRepairTime++; continue; }

      const tReparo = new Date(po.RepairTime).getTime();
      if (!Number.isFinite(tReparo)) { contas.semRepairTime++; continue; }

      const det = await getNoteDetail(n.note_id, n.sector_id || 'DESG');
      const ft = finalizandoTrabalho(det && det.Checkpoints);
      if (ft.quantos > 1) contas.multiplosEv4++;
      if (ft.semFuso) { contas.semFuso++; continue; }
      if (ft.instante == null) { contas.semEvento4++; continue; }

      const min = (ft.instante - tReparo) / 60000;
      deltas.push(min);
      const reg = { numero: n.numero, min: +min.toFixed(1), setor: n.sector_id };
      if (min < 0) negativos.push(reg);
      else if (min < MINIMO) violacoes.push(reg);
    } catch (err) {
      contas.erro++;
    }
    if (PAUSA) await dormir(PAUSA);
  }

  console.log(`  ${'.'.repeat(20)}\n`);
  const medidas = deltas.length;
  console.log(`── COBERTURA ──`);
  console.log(`  amostradas:                    ${notas.length}`);
  console.log(`  MEDIDAS (têm as duas pontas):  ${medidas}  ${pct(medidas, notas.length)}`);
  console.log(`  sem bloco PowerOnExecution:    ${contas.semPowerOn}`);
  console.log(`  HasRepair = false:             ${contas.hasRepairFalse}`);
  console.log(`  sem RepairTime:                ${contas.semRepairTime}`);
  console.log(`  sem checkpoint evento 4:       ${contas.semEvento4}`);
  console.log(`  evento 4 sem RegisteredAt2:    ${contas.semFuso}   (não estimado de propósito)`);
  console.log(`  erros de rede/HTTP:            ${contas.erro}`);
  console.log(`  notas com >1 evento 4:         ${contas.multiplosEv4}   (usado o último)`);

  if (medidas === 0) {
    console.log(`\nNenhuma nota mensurável na amostra — nada a concluir.`);
    await pool.end();
    return;
  }

  const ord = [...deltas].sort((a, b) => a - b);
  console.log(`\n── DISTRIBUIÇÃO (minutos entre reparo e Finalizando Trabalho) ──`);
  console.log(`  mínimo ${ord[0].toFixed(1)}   p10 ${percentil(ord, 10).toFixed(1)}   `
    + `mediana ${percentil(ord, 50).toFixed(1)}   p90 ${percentil(ord, 90).toFixed(1)}   `
    + `máximo ${ord[ord.length - 1].toFixed(1)}`);

  const faixas = [
    ['negativo (reparo DEPOIS)', d => d < 0],
    ['0 a 2 min',                d => d >= 0  && d < 2],
    ['2 a 5 min',                d => d >= 2  && d < 5],
    ['5 a 10 min',               d => d >= 5  && d < MINIMO],
    ['10 a 30 min',              d => d >= MINIMO && d < 30],
    ['30 a 60 min',              d => d >= 30 && d < 60],
    ['60 min ou mais',           d => d >= 60],
  ];
  console.log('');
  for (const [rotulo, teste] of faixas) {
    const q = deltas.filter(teste).length;
    const barra = '█'.repeat(Math.round(40 * q / medidas));
    console.log(`  ${rotulo.padEnd(26)} ${String(q).padStart(5)}  ${pct(q, medidas).padStart(6)}  ${barra}`);
  }

  const abaixo = violacoes.length + negativos.length;
  console.log(`\n── VEREDITO ──`);
  console.log(`  ABAIXO de ${MINIMO} min: ${abaixo} de ${medidas}  (${pct(abaixo, medidas)})`);
  console.log(`  sendo ${negativos.length} com reparo apontado DEPOIS do Finalizando Trabalho`);

  const amostraViol = [...negativos, ...violacoes].slice(0, 15);
  if (amostraViol.length) {
    console.log(`\n  Exemplos pra conferir no portal:`);
    for (const v of amostraViol) {
      console.log(`    ${v.numero}  ${String(v.min).padStart(7)} min  ${v.setor}`);
    }
  }

  console.log(`\n⚠️ Amostra das ${notas.length} notas PO mais RECENTES em cache.`);
  console.log(`   Não é aleatória: se o método de apontamento mudou no tempo, o número`);
  console.log(`   reflete o comportamento atual, não a média histórica.\n`);

  await pool.end();
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
