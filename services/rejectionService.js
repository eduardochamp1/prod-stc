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
 *   DL → endpoint desconhecido (tentamos: dl, dlrl, dldl, desligamento, corte → 404)
 *   LE → endpoint desconhecido (tentamos: le, lerl, ledl, leitura → 404)
 *   RL → endpoint desconhecido (tentamos: rl, rlrl, rldl, religacao → 404)
 *   II/PO/UG/RD/SO/DD → sem amostras nos snapshots ainda (raros)
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
};

// Pra tipos sem endpoint confirmado, varremos esses candidatos.
// Padrões observados na API: tipo direto, tipo+rl, tipo+dl, alguns sinônimos.
const CANDIDATE_PATHS = {
  DL: ['dl', 'dlrl', 'dldl', 'desligamento', 'corte'],
  LE: ['le', 'lerl', 'ledl', 'leitura'],
  RL: ['rl', 'rlrl', 'rldl', 'religacao', 'religa'],
  II: ['ii', 'iirl', 'iidl', 'inspecao'],
  PO: ['po', 'porl', 'podl', 'poda'],
  UG: ['ug', 'ugrl', 'ugdl'],
  RD: ['rd', 'rdrl', 'rddl', 'religamento'],
  SO: ['so', 'sorl', 'sodl', 'servico'],
  DD: ['dd', 'ddrl', 'dddl'],
};

// Cache de auto-descoberta — quando um tipo desconhecido revela o path certo,
// guardamos aqui pro resto da vida do processo.
const _discoveredPath = {};   // { 'DL': 'dlrl', ... }

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
  const rejection_date = rej?.RejectedAt || null;

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
};
