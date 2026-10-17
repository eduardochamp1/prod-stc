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
 *
 * Modo --so-v2 (07/10/2026): pula 1 e 2 e faz SÓ o teamsstatus/V2 (1 GET),
 * listando toda nota com ExecutionStatus 3. Hipótese levantada pelos prints do
 * portal: a coluna "Status de execução" do Gestão Online mostra "Interromp." e a
 * nota interrompida 105293301 veio com ExecutionStatus 3 — que o STATUS_V2 trata
 * como "executada (em andamento)". Compare a lista com o filtro "Interrompidas"
 * do portal (Notes/Geral).
 *   node -r dotenv/config scripts/diag-nota-interrompida.js --so-v2 --setor DESG
 *
 * --setor aceita SETOR, REGIONAL ou lista (16/10/2026). Guarapari tem DOIS
 * setores no WPA, DESG e DEPT, e a equipe é transferida entre eles conforme a
 * região ou o tipo de serviço — rodar só DESG perdia quem estava no DEPT, e o
 * José pediu pra não ter que rodar duas vezes. Agora:
 *   --setor GUA          → DESG e DEPT, em série (PADRÃO)
 *   --setor CAC | SJC    → DESC | DSSJ
 *   --setor DESG,DESC    → lista livre
 * Em série, não em paralelo: é a mesma conta WPA ('es') nos três setores do ES.
 * O teamsstatus/V2 roda 1× por setor e o resumo de ExecutionStatus 3 sai junto,
 * com o setor de cada nota. O details/optimized usa o 1º setor (a API aceita
 * qualquer um).
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
}

const ID    = arg('id', 'ab7836cc-954f-4c6f-b847-c90448135afd');  // 105293301, PO, print de 07/10/2026
// Setores de cada regional — espelho do REGIONAL_MAP (wpaService.js) e do
// SETORES (dataService.js).
const SETORES_DA_REGIONAL = { GUA: ['DESG', 'DEPT'], CAC: ['DESC'], SJC: ['DSSJ'] };
const SETORES_VALIDOS = ['DESG', 'DEPT', 'DESC', 'DSSJ'];

/** 'GUA' → ['DESG','DEPT']; 'DESG,DESC' → ['DESG','DESC']; inválido → erro. */
function resolverSetores(valor) {
  const lista = [];
  for (const parte of String(valor || '').toUpperCase().split(',').map(x => x.trim()).filter(Boolean)) {
    const setores = SETORES_DA_REGIONAL[parte] || (SETORES_VALIDOS.includes(parte) ? [parte] : null);
    if (!setores) throw new Error(`--setor inválido: "${parte}" (use GUA, CAC, SJC ou ${SETORES_VALIDOS.join('/')})`);
    for (const s of setores) if (!lista.includes(s)) lista.push(s);
  }
  if (lista.length === 0) throw new Error('--setor vazio');
  return lista;
}

const SETORES = resolverSetores(arg('setor', 'GUA'));
const SETOR   = SETORES[0];   // só pro details/optimized
const SO_V2 = process.argv.includes('--so-v2');

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

  if (!SO_V2) await detalheECompleteInterruptions(wpaFetch);
  const status3 = [];
  let achou = false;
  for (const setor of SETORES) {            // em série — mesma conta WPA
    const r = await teamsStatusV2(wpaFetch, setor);
    status3.push(...r.status3);
    achou = achou || r.achou;
  }
  if (SETORES.length > 1) {
    console.log(`\n═══ RESUMO ${SETORES.join(' + ')} ═══`);
    if (!SO_V2) console.log(achou ? '  nota encontrada (ver acima)' : '  (nota NÃO está no V2 de nenhum destes setores agora)');
    console.log(`  Notas com ExecutionStatus 3 somando os setores (${status3.length}):`);
    for (const l of status3.sort()) console.log(`    ${l}`);
  }
}

async function detalheECompleteInterruptions(wpaFetch) {
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

}

async function teamsStatusV2(wpaFetch, SETOR) {
  // ── 3. teamsstatus/V2 do setor ─────────────────────────────────────────────
  console.log(`\n═══ 3. teamsstatus/V2 — ${SETOR} ═══`);
  const v2 = await getJson(wpaFetch, `/api/teamsstatus/V2?sectorId=${SETOR}&filterByExhibitionSector=true`);
  console.log(`HTTP ${v2.status}`);
  const equipes = Array.isArray(v2.json) ? v2.json : ((v2.json && v2.json.Data) || []);
  const contagem = {};        // `${lista}:${ExecutionStatus}` → n
  const exemplos = {};        // ExecutionStatus fora de 1-7/9 → até 3 exemplos
  let achou = false;
  const status3 = [];         // notas com ExecutionStatus 3 (hipótese: interrompidas)
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
        if (es === 3) status3.push(`${SETOR} ${nomeEq.padEnd(9)} ${String(n?.Type).padEnd(3)} ${n?.Number}  Status=${n?.Status}  (${lista})`);
        if (!SO_V2 && n?.Id === ID) {
          achou = true;
          console.log(`  ➜ nota encontrada: equipe ${nomeEq}, lista ${lista}, ExecutionStatus ${es}`);
          console.log('    ', JSON.stringify(n).slice(0, 800));
        }
      }
    }
  }
  if (!SO_V2 && !achou) console.log('  (nota NÃO está em nenhuma lista do V2 deste setor agora)');
  console.log('\n  Contagem lista:ExecutionStatus no setor:');
  for (const [k, n] of Object.entries(contagem).sort()) console.log(`    ${k.padEnd(16)} ${n}`);
  console.log(`\n  Notas com ExecutionStatus 3 (${status3.length}) — conferir contra o filtro "Interrompidas" do portal:`);
  for (const l of status3.sort()) console.log(`    ${l}`);
  if (Object.keys(exemplos).length) {
    console.log('\n  ⚠️ ExecutionStatus FORA do mapa STATUS_V2 (hoje viram "baixada"):');
    for (const [es, ex] of Object.entries(exemplos)) console.log(`    ${es}: ${ex.join(' | ')}`);
  } else {
    console.log('\n  Nenhum ExecutionStatus fora do mapa neste momento.');
  }
  return { status3, achou };
}

if (require.main === module) {
  main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
}

module.exports = { resolverSetores };
