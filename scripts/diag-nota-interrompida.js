#!/usr/bin/env node
/**
 * scripts/diag-nota-interrompida.js
 *
 * READ-ONLY. Não grava nada, em lugar nenhum.
 *
 * Pedido de 07/10/2026: coluna de notas INTERROMPIDAS de MD na matriz "Notas
 * Atendidas por Tipo". O portal mostra o status "Em Campo interrompida" (tela
 * própria "Notas Interrompidas"), mas nós só conhecemos baixada / executada /
 * concluida / rejeitada. Antes de contar qualquer coisa, precisa saber de qual
 * campo da API esse status vem. Este script responde:
 *
 *   1. O detalhe CRU da nota (details/optimized): Status, ExecutionStatus e
 *      toda chave que cheire a interrupção/status.
 *   2. completeInterruptions da nota.
 *   3. teamsstatus/V2 do setor: em que lista (Concluded/Downloaded/…) a nota
 *      aparece e com que ExecutionStatus — e a CONTAGEM de todos os
 *      ExecutionStatus do setor. Suspeita: STATUS_V2 (wpaService.js) não mapeia
 *      o 8, e código desconhecido vira 'baixada' em silêncio.
 *
 * USO (na VM, dentro de ~/prod-stc):
 *   node -r dotenv/config scripts/diag-nota-interrompida.js \
 *     --id ab7836cc-954f-4c6f-b847-c90448135afd --setor DESG
 *
 * ⚠️ 3 requisições GET à API da WPA. Não faz login novo se o token estiver válido.
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
}

const ID    = arg('id', 'ab7836cc-954f-4c6f-b847-c90448135afd');  // 105293301, PO, print de 07/10/2026
const SETOR = arg('setor', 'DESG');

/** Varre o objeto e devolve [caminho, valor] das chaves que casam com a regex. */
function caçar(obj, regex, caminho = '', achados = [], prof = 0) {
  if (prof > 6 || obj === null || typeof obj !== 'object') return achados;
  for (const [k, v] of Object.entries(obj)) {
    const p = caminho ? `${caminho}.${k}` : k;
    if (regex.test(k) && (v === null || typeof v !== 'object')) achados.push([p, v]);
    if (v && typeof v === 'object') caçar(v, regex, p, achados, prof + 1);
  }
  return achados;
}

async function getJson(wpaFetch, path) {
  const r = await wpaFetch(path);
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* não-JSON */ }
  return { status: r.status, json, txt };
}

async function main() {
  const { wpaFetch } = require('../services/wpaService');

  // ── 1. Detalhe cru ──────────────────────────────────────────────────────────
  console.log(`\n═══ 1. details/optimized — ${ID} (${SETOR}) ═══`);
  const det = await getJson(wpaFetch, `/api/Notes/${ID}/details/optimized?sectorId=${SETOR}`);
  console.log(`HTTP ${det.status}`);
  const nota = det.json && (det.json.Data || det.json);
  if (!nota || typeof nota !== 'object') {
    console.log('Resposta não-JSON:', det.txt.slice(0, 300));
  } else {
    for (const k of ['Number', 'Type', 'Status', 'ExecutionStatus', 'ConclusionStatus',
      'ConclusionDate', 'TeamId', 'TeamName', 'Try', 'StatusSurvey']) {
      console.log(`  ${k.padEnd(18)} ${JSON.stringify(nota[k])}`);
    }
    console.log('  Interruptions     ', JSON.stringify(nota.Interruptions || null));
    console.log('\n  Chaves com status/interr/situa/state (varredura completa):');
    for (const [p, v] of caçar(nota, /status|interr|situa|state/i)) {
      console.log(`    ${p} = ${JSON.stringify(v)}`);
    }
  }

  // ── 2. completeInterruptions ───────────────────────────────────────────────
  console.log(`\n═══ 2. completeInterruptions ═══`);
  const ci = await getJson(wpaFetch, `/api/Notes/${ID}/completeInterruptions`);
  console.log(`HTTP ${ci.status}`);
  console.log(JSON.stringify(ci.json ?? ci.txt.slice(0, 500), null, 2).slice(0, 2000));

  // ── 3. teamsstatus/V2 do setor ─────────────────────────────────────────────
  console.log(`\n═══ 3. teamsstatus/V2 — ${SETOR} ═══`);
  const v2 = await getJson(wpaFetch, `/api/teamsstatus/V2?sectorId=${SETOR}&filterByExhibitionSector=true`);
  console.log(`HTTP ${v2.status}`);
  const equipes = Array.isArray(v2.json) ? v2.json : ((v2.json && v2.json.Data) || []);
  const contagem = {};        // `${lista}:${ExecutionStatus}` → n
  const exemplos = {};        // ExecutionStatus fora de 1-7/9 → até 3 exemplos
  let achou = false;
  for (const eq of equipes) {
    const nomeEq = eq?.Session?.Team?.Name || eq?.Team?.Name || '?';
    for (const lista of ['Assigned', 'Downloaded', 'Executed', 'Concluded', 'Rejected']) {
      for (const n of (eq?.[lista] || [])) {
        const es = n?.ExecutionStatus;
        const chave = `${lista}:${es}`;
        contagem[chave] = (contagem[chave] || 0) + 1;
        if (![1, 2, 3, 4, 5, 6, 7, 9].includes(es)) {
          (exemplos[es] = exemplos[es] || []);
          if (exemplos[es].length < 3) exemplos[es].push(`${nomeEq} ${n?.Type} ${n?.Number} (${lista})`);
        }
        if (n?.Id === ID) {
          achou = true;
          console.log(`  ➜ nota encontrada: equipe ${nomeEq}, lista ${lista}, ExecutionStatus ${es}`);
          console.log('    ', JSON.stringify(n).slice(0, 800));
        }
      }
    }
  }
  if (!achou) console.log('  (nota NÃO está em nenhuma lista do V2 deste setor agora)');
  console.log('\n  Contagem lista:ExecutionStatus no setor:');
  for (const [k, n] of Object.entries(contagem).sort()) console.log(`    ${k.padEnd(16)} ${n}`);
  if (Object.keys(exemplos).length) {
    console.log('\n  ⚠️ ExecutionStatus FORA do mapa STATUS_V2 (hoje viram "baixada"):');
    for (const [es, ex] of Object.entries(exemplos)) console.log(`    ${es}: ${ex.join(' | ')}`);
  } else {
    console.log('\n  Nenhum ExecutionStatus fora do mapa neste momento.');
  }
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
