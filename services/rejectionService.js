/**
 * services/rejectionService.js
 * Coleta detalhes de notas rejeitadas no WPA EDP.
 *
 * Cada nota rejeitada no WPA tem na UI um bloco "Detalhes da Rejeição" com:
 *   - Data da rejeição
 *   - Observação (texto livre do operador)
 *   - Motivos (lista de códigos categorizados, ex: "0101 - Depende de projeto elétrico")
 *   - Formulário (ex: "Vistoria de Entrada e Serviço")
 *
 * Esses dados não vêm na lista de notas (`/notes/{cat}/{session}/session`)
 * nem no `/Notes/{id}/details/optimized`. São expostos em
 * `/api/notes/{tipoPath}?noteId={uuid}` no campo `Data.Rejection` e
 * `Data.RejectionRen1000`.
 *
 * MAPEAMENTO DE ENDPOINTS POR TIPO (descoberto experimentalmente):
 *
 *   MD → /api/notes/md         (confirmado — Data.Rejection)
 *   LN → /api/notes/lnrl       (confirmado — Data.Rejection)
 *   SF → /api/notes/sfdl       (confirmado — primary)
 *      → /api/notes/sfrl       (fallback)
 *   DL → resolvido por AUTO-DESCOBERTA via FALLBACK_PATHS (ver medição abaixo)
 *   LE → idem
 *   RL → idem
 *   II/PO/UG/RD/SO/DD → sem amostras nos snapshots ainda (raros)
 *
 * ⚠️ CORREÇÃO DE 21/08/2026 — o parágrafo acima dizia "DL/LE/RL: endpoint
 * desconhecido", e isso ficou desatualizado sem ninguém notar. A medição de
 * cobertura de `RejectedAt` (jun–ago/2026, `scripts/diag-rejeicoes-datas.js`)
 * mostra que a auto-descoberta pelos FALLBACK_PATHS resolve esses três:
 *
 *     tipo   rejeições   sem RejectedAt
 *     DL         1259          1  (0%)
 *     LE         1140          2  (0%)
 *     RL          564          1  (0%)
 *     SF         7135          3  (0%)
 *     LN         1583          1  (0%)
 *     MD         2423          0  (0%)
 *     VL         1278       1278  (100%)   ← o problema real
 *     SM           16         16  (100%)
 *
 * VL e SM simplesmente NÃO ESTAVAM em CANDIDATE_PATHS, e tipo sem candidato cai
 * no ramo `uniquePaths.length === 0`, que devolve `endpoint_missing` sem fazer
 * UMA chamada. Não era "endpoint que não existe": era tipo que nunca foi tentado.
 * Corrigido incluindo VL/SM na tabela (+ cache negativo, ver _noPathForTipo).
 *
 * CONFIRMADO no mesmo dia: `/api/notes/vl` EXISTE — o backfill trouxe data e
 * motivo em 20/20 notas VL. Promovido pra KNOWN_PATHS. Detalhe que contraria a
 * nota de 25/05: path POR TIPO funciona pro VL, então nem tudo é por formulário.
 *
 * Estratégia pra tipos com endpoint desconhecido:
 *   - Auto-descoberta: tenta uma lista de candidatos e cacheia o primeiro que
 *     retornar 200 com `Data.Rejection`. Cache vive enquanto o processo vive.
 *   - Se nenhum candidato funcionar, grava a rejeição mesmo assim mas com
 *     `motivo_codes=[]` e flag `endpoint_missing` no `raw`. Isso garante que
 *     a contagem de rejeições por equipe/regional continua correta — só os
 *     detalhes categorizados ficam vazios pra esses tipos.
 *
 * Estrutura esperada na resposta (campos relevantes):
 *
 *   Data.Rejection: {
 *     RejectionReasons:    [{ Code, Description, Label }],
 *     RejectionReasonIds:  "0101|0031",
 *     RejectedAt:          "2026-05-03T14:43:00",
 *     RejectedById:        "98a3ea51-...",
 *     SessionId:           "82b15759-...",
 *     Observation:         ""
 *   }
 *   Data.RejectionRen1000: {                  (Ren = renderização do form)
 *     RejectionHeader: {
 *       Observation: "inversora diferente da do projeto",
 *       FormId:      "1d5be888-..."           (descobre o nome do formulário)
 *     },
 *     RejectionReasons: [...]
 *   }
 *
 * USO:
 *   const { fetchRejectionDetails } = require('./rejectionService');
 *   const det = await fetchRejectionDetails(noteId, 'MD');
 *   // det = { motivo_codes, motivo_textos, observacao, formulario, rejection_date, raw } | null
 */

const { wpaFetch } = require('./wpaService');

// ── Dispatch ─────────────────────────────────────────────────────────────────

// Endpoints confirmados (testados em produção e validados).
// O array é tentado em ordem — primeiro 200 com Data.Rejection vence.
const KNOWN_PATHS = {
  MD: ['md'],
  LN: ['lnrl'],
  SF: ['sfdl', 'sfrl'],
  // VL confirmado em 21/08/2026: o backfill descobriu `/api/notes/vl` e trouxe
  // data + motivo em 20/20 notas, em ~1s. Promovido de CANDIDATE pra KNOWN pra
  // não pagar os 4 FALLBACK_PATHS em 404 na primeira nota VL de cada processo.
  //
  // ⚠️ Nuance que contraria a nota de 25/05/2026 logo abaixo: ela concluiu que
  // "o endpoint é por FORMULÁRIO, não por tipo — por isso 'rl'/'rlrl' deram 404".
  // Verdade pra RL, mas NÃO é regra geral: `vl` é path POR TIPO e existe. Ou
  // seja, valem os dois padrões, e manter candidatos por tipo na lista tem
  // retorno real — foi o que resolveu o VL.
  VL: ['vl'],
};

// Pra tipos sem endpoint confirmado, varremos esses candidatos.
// DESCOBERTA via DevTools (25/05/2026): o endpoint NAO eh por tipo da nota,
// eh por tipo do FORMULARIO. Uma nota RL com formulario "Vistoria de Entrada
// e Servico" (SF) responde em /api/notes/sfrl. Por isso 'rl'/'rlrl'/etc
// sempre deram 404 — esses paths nao existem.
//
// Estrategia: sempre tentar os endpoints conhecidos (sfrl, sfdl, lnrl, md)
// pra qualquer tipo nao mapeado. O auto-discovery cacheia o que funcionar
// pra cada combinacao (tipo,formulario) no escopo do processo.
const FALLBACK_PATHS = ['sfrl', 'sfdl', 'lnrl', 'md'];

const CANDIDATE_PATHS = {
  // 21/08/2026 — VL e SM não estavam AQUI, e o efeito não era "sem motivo": era
  // ZERO tentativa. Tipo fora de KNOWN_PATHS e de CANDIDATE_PATHS cai no ramo
  // `uniquePaths.length === 0` mais abaixo, que devolve endpoint_missing SEM
  // nenhuma chamada — logo sem `motivo_codes` E sem `rejection_date`. A medição
  // do P0-8 achou VL com 1278 rejeições e 100% sem RejectedAt, contra ~0% em
  // todos os outros tipos. Faltar o RejectedAt não é cosmético: o
  // `_rejIndexByNote` cai pro `session_date` (o dia em que o coletor VIU), que
  // com o arrasto entre snapshots pode estar 1 dia à frente do fato e SUPRIMIR
  // produção legítima (backlog P2-32).
  // FALLBACK_PATHS (endpoint por FORMULÁRIO) foi o que resolveu DL/LE/RL. Pro VL,
  // quem respondeu foi o path POR TIPO `vl` — já promovido a KNOWN_PATHS. Os dois
  // padrões existem, então a lista mantém as duas famílias de candidato.
  VL: [...FALLBACK_PATHS, 'vl', 'vlrl', 'vldl', 'vistoria'],
  SM: [...FALLBACK_PATHS, 'sm', 'smrl', 'smdl'],
  DL: [...FALLBACK_PATHS, 'dl', 'dlrl', 'dldl', 'desligamento', 'corte'],
  LE: [...FALLBACK_PATHS, 'le', 'lerl', 'ledl', 'leitura'],
  RL: [...FALLBACK_PATHS, 'rl', 'rlrl', 'rldl', 'religacao', 'religa'],
  II: [...FALLBACK_PATHS, 'ii', 'iirl', 'iidl', 'inspecao'],
  PO: [...FALLBACK_PATHS, 'po', 'porl', 'podl', 'poda'],
  UG: [...FALLBACK_PATHS, 'ug', 'ugrl', 'ugdl'],
  RD: [...FALLBACK_PATHS, 'rd', 'rdrl', 'rddl', 'religamento'],
  SO: [...FALLBACK_PATHS, 'so', 'sorl', 'sodl', 'servico'],
  DD: [...FALLBACK_PATHS, 'dd', 'ddrl', 'dddl'],
};

// Cache de auto-descoberta — quando um tipo desconhecido revela o path certo,
// guardamos aqui pro resto da vida do processo.
const _discoveredPath = {};   // { 'DL': 'dlrl', ... }

// Cache NEGATIVO (21/08/2026). Sem ele, um tipo cujos candidatos todos falham
// paga a lista inteira em CADA nota — 1278 rejeições VL × 8 candidatos seriam
// ~10 mil requests inúteis na conta compartilhada da EDP (que é a mesma do outro
// projeto, ver P1-25). Agora o tipo é tentado uma vez por processo: se todos os
// candidatos derem 404, marca aqui e as notas seguintes nem tentam.
// Só entra aqui em 404 puro. Se algum candidato devolveu 500, o endpoint EXISTE
// e a falha é da nota (arquivada/limpa) — não envenena o cache.
const _noPathForTipo = new Set();

/** Estado do cache negativo (debug/teste). */
function getNoPathTipos() { return [..._noPathForTipo]; }
function _resetNoPathCache() { _noPathForTipo.clear(); }

// ── helpers ──────────────────────────────────────────────────────────────────

async function tryEndpoint(path, noteId) {
  try {
    const res = await wpaFetch(`/api/notes/${path}?noteId=${noteId}`);
    if (res.status === 404) return { ok: false, status: 404 };
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    const rej    = json?.Data?.Rejection;
    const rejRen = json?.Data?.RejectionRen1000;
    if (!rej && !rejRen) return { ok: false, status: res.status, noRejection: true };
    return { ok: true, json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Extrai estrutura normalizada de Data.Rejection + Data.RejectionRen1000. */
function normalize(json) {
  const rej    = json?.Data?.Rejection || null;
  const rejRen = json?.Data?.RejectionRen1000 || null;

  // Lista de motivos. IMPORTANTE: as duas fontes têm SCHEMAS DIFERENTES:
  //   Rejection.RejectionReasons[]:      { Code, Description, Label, ... }
  //   RejectionRen1000.RejectionReasons[]: { Number, Description, FormGroupsId, ... }
  //                                        ↑ aqui é "Number", NÃO "Code"
  // Preferimos `Rejection` porque tem Description sem prefixo "0067 - " e Code
  // limpo. Fallback pro Ren1000 com Number→code. Dedup por código final.
  const reasonsSrc = (rej?.RejectionReasons?.length ? rej.RejectionReasons : rejRen?.RejectionReasons) || [];
  const seen = new Set();
  const motivo_codes  = [];
  const motivo_textos = [];
  for (const r of reasonsSrc) {
    // Tenta Code (Rejection), depois Number (Ren1000), depois Codigo (legado).
    const code = String(r?.Code || r?.Number || r?.Codigo || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    motivo_codes.push(code);
    // Description vem limpa no Rejection ("Falta proteção") ou com prefixo
    // no Ren1000 ("0011 - Falta proteção"). O replace tira o prefixo se houver.
    motivo_textos.push(String(r?.Description || r?.Label || '').replace(/^\d+\s*-\s*/, '').trim());
  }

  // Observação: o form Ren1000 tem texto livre do operador; Rejection.Observation
  // costuma ser vazio (mas tentamos como fallback).
  const observacao = (rejRen?.RejectionHeader?.Observation || rej?.Observation || '').trim() || null;

  // Data: usar RejectedAt do bloco Rejection (sempre presente quando há rejeição).
  // EDP retorna em UTC mas SEM marker (ex: "2026-06-03T19:28:00"). Sem o 'Z'
  // explícito, o Postgres interpreta usando o timezone da sessão (BRT no nosso
  // servidor), gravando o instante 3h adiantado. Concatena Z se faltar TZ.
  // Confirmado por diagnóstico em 03/06/2026: rejeição às 17:34 BRT chegava
  // como "20:34 BRT" no banco (= 23:34 UTC = errado).
  let rejection_date = rej?.RejectedAt || null;
  if (rejection_date && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(rejection_date)) {
    rejection_date = rejection_date + 'Z';
  }

  // Formulário: por ora só guardamos FormId — depois mapeamos pra nome humano se necessário.
  const formulario = rejRen?.RejectionHeader?.FormId || null;

  return { motivo_codes, motivo_textos, observacao, rejection_date, formulario };
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Busca detalhes da rejeição de uma nota.
 * @param {string} noteId  UUID da nota
 * @param {string} tipo    'MD', 'LN', 'SF', 'DL', etc
 * @returns {Promise<{
 *   motivo_codes:   string[],
 *   motivo_textos:  string[],
 *   observacao:     string|null,
 *   rejection_date: string|null,
 *   formulario:     string|null,
 *   raw:            object,           // payload bruto pra debug
 *   endpoint:       string|null,      // qual path funcionou
 *   endpoint_missing: boolean         // true se não conseguimos descobrir o path
 * }|null>}  null se erro irrecuperável (rede etc — chamador decide tentar de novo)
 */
async function fetchRejectionDetails(noteId, tipo) {
  if (!noteId) return null;
  const TIPO = String(tipo || '').toUpperCase();

  // Lista efetiva de paths a tentar
  const paths = [];
  if (_discoveredPath[TIPO]) paths.push(_discoveredPath[TIPO]);
  if (KNOWN_PATHS[TIPO])     paths.push(...KNOWN_PATHS[TIPO]);
  if (CANDIDATE_PATHS[TIPO]) paths.push(...CANDIDATE_PATHS[TIPO]);

  // Dedup preservando ordem
  const tried = new Set();
  const uniquePaths = paths.filter(p => { if (tried.has(p)) return false; tried.add(p); return true; });

  if (uniquePaths.length === 0) {
    console.warn(`[rejectionService] tipo=${TIPO} sem candidatos de endpoint conhecidos`);
    return {
      motivo_codes: [], motivo_textos: [], observacao: null,
      rejection_date: null, formulario: null, raw: { unknown_tipo: TIPO },
      endpoint: null, endpoint_missing: true,
    };
  }

  // Cache negativo: este tipo já esgotou todos os candidatos com 404 neste
  // processo. Não gasta requisição de novo nota a nota.
  if (_noPathForTipo.has(TIPO)) {
    return {
      motivo_codes: [], motivo_textos: [], observacao: null,
      rejection_date: null, formulario: null,
      raw: { no_path_cached: TIPO },
      endpoint: null, endpoint_missing: true,
    };
  }

  let last500 = null;
  for (const path of uniquePaths) {
    const r = await tryEndpoint(path, noteId);
    if (r.ok) {
      // Cacheia o path descoberto pra tipos não-confirmados
      if (!KNOWN_PATHS[TIPO]?.includes(path) && !_discoveredPath[TIPO]) {
        _discoveredPath[TIPO] = path;
        console.log(`[rejectionService] descoberto: ${TIPO} → /api/notes/${path}`);
      }
      const norm = normalize(r.json);
      return {
        ...norm,
        raw: r.json?.Data || {},
        endpoint: path,
        endpoint_missing: false,
      };
    }
    if (r.status === 500) last500 = path;  // memoriza endpoint que ao menos existe
    // 404 / outras falhas: continua tentando
  }

  // Nenhum candidato deu 200. Se ao menos 1 deu 500, sabemos que o endpoint
  // existe mas a nota está com problema (provavelmente foi arquivada/limpa).
  // Retorna estrutura vazia mas sinaliza que a tentativa foi feita.
  console.warn(`[rejectionService] tipo=${TIPO} noteId=${noteId.slice(0, 8)} sem 200 (last500=${last500 || 'nenhum'})`);
  // 404 em TODOS os candidatos → o path não existe pra este tipo. Marca pro
  // resto do processo (ver _noPathForTipo). Com um 500 no meio, não marca: o
  // endpoint existe e o problema é da nota.
  if (!last500) {
    _noPathForTipo.add(TIPO);
    console.warn(`[rejectionService] tipo=${TIPO} marcado como SEM path — não tento de novo neste processo`);
  }
  return {
    motivo_codes: [], motivo_textos: [], observacao: null,
    rejection_date: null, formulario: null,
    raw: { all_failed: true, last500 },
    endpoint: last500 || null,
    endpoint_missing: !last500,
  };
}

/** Retorna o snapshot de paths descobertos (útil pra debug/log). */
function getDiscoveredPaths() {
  return { ...KNOWN_PATHS, ..._discoveredPath };
}

module.exports = {
  fetchRejectionDetails,
  getDiscoveredPaths,
  getNoPathTipos, _resetNoPathCache,   // cache negativo (21/08/2026) — exportado p/ teste
  CANDIDATE_PATHS, KNOWN_PATHS,        // exportados p/ teste de cobertura de tipos
};
