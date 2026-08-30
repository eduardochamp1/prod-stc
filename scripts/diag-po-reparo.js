#!/usr/bin/env node
/**
 * scripts/diag-po-reparo.js
 *
 * READ-ONLY. Não grava nada, em lugar nenhum.
 *
 * Levantamento pra métrica pedida em 29/08/2026: nas notas **PO**, medir o tempo
 * entre o **"Horário do Reparo"** e o checkpoint **"Finalizando Trabalho"**.
 * Diferença menor que 10 minutos indica problema no método de apontamento da
 * equipe — e esses minutos contam no **CHI** do CSD que atendemos.
 *
 * Antes de desenhar qualquer coisa, duas perguntas de FATO precisam de resposta,
 * e este script responde as duas:
 *
 * ── 1. Qual código de Event é "Finalizando Trabalho"? ────────────────────────
 * Temos DUAS listas de eventos no repo e elas DISCORDAM entre si:
 *
 *   db/deslocamentosQueries.js:7  →  2=Início do Trabalho  3=Fim do Trabalho  4=Interrupção
 *   public/index.html CP_LABELS   →  2=Serviço concluído   3=Saída do cliente 4=Retorno/fim
 *
 * E o portal da EDP mostra CINCO checkpoints, com "Finalizando Trabalho" ENTRE
 * "Início do Trabalho" e "Fim do Trabalho" — um evento que nenhuma das duas
 * listas prevê. Como o painel já usa o par 0→1 pra calcular deslocamento, saber
 * o mapa real não é curiosidade: é pré-requisito.
 *
 * O script imprime os checkpoints JÁ CACHEADOS da nota, com evento e horário,
 * pra casar linha a linha com o que o portal mostra.
 *
 * ── 2. O "Horário do Reparo" vem na resposta da EDP? ─────────────────────────
 * Ele aparece no portal em "Detalhes da Execução → Ocorrência", mas NÃO está no
 * nosso payload: o notaProcessor mapeia um conjunto fixo de campos e não tem
 * nada de ocorrência/reparo. Pode ser que a EDP mande e a gente jogue fora, ou
 * pode ser que venha de outro endpoint. São conclusões opostas.
 *
 * O script busca o detalhe CRU na API e varre o JSON inteiro atrás de qualquer
 * chave que cheire a reparo/ocorrência, imprimindo o caminho e o valor.
 *
 * USO (na VM):
 *   node -r dotenv/config scripts/diag-po-reparo.js --numero 104875481
 *   node -r dotenv/config scripts/diag-po-reparo.js --numero 104875481 --dump-chaves
 *   node -r dotenv/config scripts/diag-po-reparo.js --numero 104875481 --probe-endpoints
 *
 * ⚠️ Faz 1 requisição à API da WPA (ou 10, com --probe-endpoints). Todas GET.
 * Não faz login novo se o token estiver válido. Não escreve no banco.
 */

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
}
const flag = (n) => process.argv.includes(`--${n}`);

const NUMERO = arg('numero', '104875481');   // a do print de 29/08/2026
const REGIONAL_MAP = { DESG: 'GUA', DEPT: 'GUA', DESC: 'CAC', DSSJ: 'SJC' };

/** Varre um objeto recursivamente e devolve [caminho, valor] das chaves que casam. */
function caçar(obj, regex, caminho = '', achados = [], profundidade = 0) {
  if (profundidade > 6 || obj === null || typeof obj !== 'object') return achados;
  for (const [k, v] of Object.entries(obj)) {
    const p = caminho ? `${caminho}.${k}` : k;
    if (regex.test(k) && (v === null || typeof v !== 'object')) {
      achados.push([p, v]);
    }
    if (v && typeof v === 'object') {
      // Em array, olha só os 2 primeiros — o resto é repetição da mesma forma.
      if (Array.isArray(v)) {
        v.slice(0, 2).forEach((item, i) => caçar(item, regex, `${p}[${i}]`, achados, profundidade + 1));
      } else {
        caçar(v, regex, p, achados, profundidade + 1);
      }
    }
  }
  return achados;
}

function hhmm(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function main() {
  const { _getPool } = require('../services/pgShim');
  const pool = _getPool();
  if (!pool) { console.error('Sem pool. Rode com `node -r dotenv/config` na VM.'); process.exit(1); }

  console.log(`\n=== diag-po-reparo — nota ${NUMERO} ===\n`);

  // ── 1. O que temos cacheado ────────────────────────────────────────────────
  const { rows } = await pool.query(
    `SELECT note_id, numero, tipo, sector_id, fetched_at, payload
       FROM public.note_details WHERE numero = $1 LIMIT 1`, [NUMERO]);

  if (rows.length === 0) {
    console.error(`Nota ${NUMERO} não está no cache note_details.`);
    console.error('Passe outra com --numero, ou abra a OS no painel pra ela ser cacheada.');
    await pool.end();
    process.exit(2);
  }

  const nd = rows[0];
  const p  = nd.payload || {};
  console.log(`note_id:   ${nd.note_id}`);
  console.log(`tipo:      ${nd.tipo}   setor: ${nd.sector_id} (${REGIONAL_MAP[nd.sector_id] || '?'})`);
  console.log(`buscada:   ${hhmm(nd.fetched_at)}`);
  console.log(`emissão:   ${hhmm(p.datas && p.datas.emissao)}`);
  console.log(`conclusão: ${hhmm(p.datas && p.datas.conclusao)}`);

  // ── 2. Os checkpoints, pra casar com o portal ──────────────────────────────
  console.log(`\n── CHECKPOINTS CACHEADOS (casar linha a linha com o portal) ──`);
  const cps = Array.isArray(p.checkpoints) ? p.checkpoints : [];
  if (cps.length === 0) {
    console.log('  (nenhum)');
  } else {
    console.log('  #  event  tentativa  horário');
    cps.forEach((cp, i) => {
      console.log(`  ${String(i + 1).padStart(2)}  ${String(cp.event).padStart(5)}  `
        + `${String(cp.tentativa ?? '—').padStart(9)}  ${hhmm(cp.timestamp)}`);
    });
    console.log('\n  No portal, a nota do print de 29/08 mostrava, nesta ordem:');
    console.log('    1 Início do Deslocamento  2 Fim do Deslocamento  3 Início do Trabalho');
    console.log('    4 Finalizando Trabalho    5 Fim do Trabalho');
    console.log('  → o `event` da 4ª linha é o código de "Finalizando Trabalho".');
  }

  // ── 3. Chaves do payload processado (o que guardamos) ──────────────────────
  console.log(`\n── CAMPOS QUE O NOSSO PAYLOAD GUARDA ──`);
  console.log('  ' + Object.keys(p).join(', '));
  const noProcessado = caçar(p, /repair|reparo|occurr|ocorr/i);
  console.log(`  campos de reparo/ocorrência no processado: `
    + (noProcessado.length ? JSON.stringify(noProcessado) : 'NENHUM (esperado)'));

  // ── 4. O detalhe CRU da EDP ────────────────────────────────────────────────
  console.log(`\n── BUSCANDO O DETALHE CRU NA EDP (1 request) ──`);
  let raw;
  try {
    const { getNoteDetail } = require('../services/wpaService');
    raw = await getNoteDetail(nd.note_id, nd.sector_id || 'DESG');
  } catch (err) {
    console.error(`  FALHOU: ${err.message}`);
    console.error('  Sem isso não dá pra saber se o Horário do Reparo vem da API.');
    await pool.end();
    process.exit(3);
  }
  if (!raw) {
    console.error('  A API devolveu vazio.');
    await pool.end();
    process.exit(3);
  }

  console.log(`  chaves de 1º nível (${Object.keys(raw).length}):`);
  console.log('  ' + Object.keys(raw).sort().join(', '));

  console.log(`\n── CAÇANDO O "HORÁRIO DO REPARO" NO CRU ──`);
  const achados = caçar(raw, /repair|reparo|occurr|ocorr|fix/i);
  if (achados.length === 0) {
    console.log('  NENHUM campo de reparo/ocorrência no details/optimized.');
    console.log('  → o dado vem de OUTRO endpoint. A métrica exige descobrir qual');
    console.log('    antes de qualquer implementação.');
  } else {
    console.log(`  ${achados.length} campo(s):`);
    for (const [caminho, valor] of achados) console.log(`    ${caminho} = ${JSON.stringify(valor)}`);
    console.log('  → a EDP MANDA e o notaProcessor descarta. Passa a ser questão de mapear.');
  }

  // Campos de data/hora soltos ajudam a achar o campo mesmo com nome inesperado.
  console.log(`\n── OUTROS CAMPOS DE DATA/HORA NO 1º NÍVEL ──`);
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T|^\d{2}\/\d{2}\/\d{4}/.test(v)) {
      console.log(`    ${k} = ${v}`);
    }
  }

  // ── 4b. Os checkpoints CRUS, campo a campo ────────────────────────────────
  // Direto ao ponto da métrica: nosso cache marcou o evento 4 às 17:26:02 e o
  // portal mostra 17:25:47 — 15s de diferença. Não muda um veredito de 7min, mas
  // muda num caso de borda perto dos 10min. Precisamos saber QUAL campo o portal
  // exibe pra medir a mesma coisa que a EDP mede.
  //
  // De quebra isto mostra `DisplacementMinutes` e `DisplacementInTrafficMinutes`,
  // que a EDP manda e nós ignoramos — hoje estimamos deslocamento via OSRM.
  console.log(`\n── CHECKPOINTS CRUS (qual campo de horário o portal usa?) ──`);
  const cpsRaw = Array.isArray(raw.Checkpoints) ? raw.Checkpoints : [];
  const ordenados = [...cpsRaw].sort((a, b) =>
    String(a.RegisteredAt || a.TimeStamp || '').localeCompare(String(b.RegisteredAt || b.TimeStamp || '')));
  for (const cp of ordenados) {
    console.log(`  Event=${cp.Event}  Try=${cp.Try}`);
    console.log(`      TimeStamp     = ${cp.TimeStamp}`);
    console.log(`      RegisteredAt  = ${cp.RegisteredAt}`);
    console.log(`      RegisteredAt2 = ${cp.RegisteredAt2}`);
    console.log(`      ValidTime=${cp.ValidTime}  DisplacementMinutes=${cp.DisplacementMinutes}`
      + `  DisplacementInTrafficMinutes=${cp.DisplacementInTrafficMinutes}`);
  }
  console.log('\n  Referência do portal pra esta nota (29/08/2026):');
  console.log('    Início do Deslocamento 16:40:53 · Fim do Deslocamento 16:51:24');
  console.log('    Início do Trabalho     16:53:17 · Finalizando Trabalho  17:25:47');
  console.log('    Fim do Trabalho        17:35:06 · Horário do Reparo     17:18:45');

  // ── 4c. Onde mora o "Horário do Reparo"? ──────────────────────────────────
  // Só GETs, read-only. `optimized` no nome do endpoint que já usamos sugere que
  // existe uma versão completa — é a primeira hipótese e a mais barata.
  if (flag('probe-endpoints')) {
    console.log(`\n── SONDANDO ENDPOINTS (somente GET, nada é gravado) ──`);
    const { wpaFetch } = require('../services/wpaService');
    const sid = encodeURIComponent(nd.sector_id || 'DESG');
    const nid = encodeURIComponent(nd.note_id);
    // Não são chutes: são os endpoints que o PRÓPRIO PORTAL chama ao abrir a
    // nota, capturados com o Interceptor do Postman em 30/08/2026. A ordem é a
    // da minha aposta — `completeInterruptions` primeiro porque, numa nota de
    // emergência, "Horário do Reparo" é quando a interrupção foi sanada. Esse
    // endpoint já tem wrapper nosso (getNoteInterruptions, P1-33) que nunca foi
    // ligado a nada — e o normalizador dele descarta campo desconhecido, então
    // só o cru responde.
    const candidatos = [
      `/api/Notes/${nid}/completeInterruptions`,
      `/api/notesMEC/${nid}`,
      `/api/Notes/${nid}/historic`,
      `/api/notes/getFormattedEquipments/${nid}`,
      `/api/callback-information?noteId=${nid}`,
      `/api/notes/${nid}/getnotebreakdisplacementtime`,
      `/api/listener-mode/logs?noteId=${nid}`,
      `/api/notes/clustering/getName/${nid}`,
      `/api/Notes/${nid}/details?sectorId=${sid}`,
    ];
    for (const path of candidatos) {
      // try/catch em volta do endpoint INTEIRO: em 30/08 o completeInterruptions
      // devolveu 200 com corpo `null` e a leitura de `.Data` estourou, abortando
      // os outros 8. Nenhum candidato pode derrubar a sonda.
      try {
        let r;
        try {
          r = await wpaFetch(path);
        } catch (err) {
          console.log(`  ${path}\n      erro de rede: ${err.message}`);
          continue;
        }
        if (!r.ok) { console.log(`  ${path}\n      HTTP ${r.status}`); continue; }

        let body;
        try { body = await r.json(); }
        catch { console.log(`  ${path}\n      HTTP 200, corpo não-JSON`); continue; }

        // `Data: null` é resposta VÁLIDA — significa "não há registro pra esta
        // nota", não erro. Distinguir isso de "endpoint errado" importa: pode ser
        // o endpoint certo e a nota é que não tem ocorrência.
        const d = (body && typeof body === 'object' && 'Data' in body) ? body.Data : body;
        if (d === null || d === undefined) {
          console.log(`  ${path}\n      HTTP 200 · corpo VAZIO (null) — endpoint existe, nota sem registro`);
          continue;
        }

        const chaves = (d && typeof d === 'object') ? Object.keys(d).length : 0;
        const hits = caçar(d, /repair|reparo|occurr|ocorr/i);
        console.log(`  ${path}\n      HTTP 200 · ${Array.isArray(d) ? `array[${d.length}]` : `${chaves} chaves`}`
          + ` · reparo/ocorrência: ` + (hits.length ? JSON.stringify(hits.slice(0, 8)) : 'nenhum'));
        // 17:18:45 é o Horário do Reparo do print. Procurar o horário CRU acha o
        // campo mesmo que o nome dele não tenha nada a ver com "reparo" — que é
        // o caso se vier como "RestorationTime", "PowerOnDate" e afins.
        // 20:18:45 é o mesmo instante em UTC, que é como a EDP costuma mandar.
        const txt = JSON.stringify(d);
        const achou = ['17:18:45', 'T17:18', '20:18:45'].filter(a => txt.includes(a));
        if (achou.length) {
          console.log(`      ⭐⭐ ACHOU ${achou.join(', ')} — esta é a origem do Horário do Reparo`);
          console.log(`      ── resposta completa ──`);
          console.log(JSON.stringify(d, null, 2).split('\n').slice(0, 120).map(l => '      ' + l).join('\n'));
        } else if (chaves > 0 || (Array.isArray(d) && d.length)) {
          // Sem o horário-alvo, as CHAVES ainda dizem se vale insistir neste
          // endpoint com outra nota (esta pode simplesmente não ter ocorrência).
          const amostra = Array.isArray(d) ? d[0] : d;
          if (amostra && typeof amostra === 'object') {
            console.log(`      campos: ${Object.keys(amostra).slice(0, 30).join(', ')}`);
          }
        }
      } catch (err) {
        console.log(`      (candidato ignorado — ${err.message})`);
      }
    }
  }

  if (flag('dump-chaves')) {
    console.log(`\n── ÁRVORE DE CHAVES (2 níveis) ──`);
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object') {
        const amostra = Array.isArray(v) ? (v[0] || {}) : v;
        const sub = (amostra && typeof amostra === 'object') ? Object.keys(amostra) : [];
        console.log(`    ${k}${Array.isArray(v) ? `[${v.length}]` : ''}: ${sub.slice(0, 25).join(', ')}`);
      }
    }
  }

  // ── 5. Tamanho do universo PO ──────────────────────────────────────────────
  const { rows: po } = await pool.query(
    `SELECT count(*)::int AS total,
            min(fetched_at)::date AS mais_antiga,
            max(fetched_at)::date AS mais_nova
       FROM public.note_details WHERE tipo = 'PO'`);
  console.log(`\n── UNIVERSO PO NO CACHE ──`);
  console.log(`  ${po[0].total} notas PO, de ${po[0].mais_antiga} a ${po[0].mais_nova}`);

  await pool.end();
  console.log('');
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
