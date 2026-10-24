/**
 * services/classifierService.js
 * Classificador de subcategorias de notas WPA (MD, SF, DD).
 *
 * Estratégia (endpoints leves do WPA — calibrada com dados reais):
 *
 *   MD → /api/notes/md?noteId={uuid}            (~2.6 KB) — Code, CodeText
 *      + /api/notepriorities/GetByNoteId/{uuid} (~1.6 KB) — SubProject
 *      • SubProject "TL11*"   → Subs TL11   (engloba "TL11 Conv", "TL11 Tele", etc.)
 *      • SubProject "OBSOLETO"→ Subs Obsoleto
 *      • SubProject NULL + Code "SPEB" → Subs Obsoleto (regra de negócio)
 *
 *   SF → /api/notes/sfdl?noteId={uuid}          (~2 KB) — tenta primeiro (SF local)
 *      → /api/notes/sfrl?noteId={uuid}          (~2 KB) — fallback (SF remoto, maioria)
 *      • Code "SRED" → Corte Disjuntor (literal)
 *      • Code "SREB" → Corte Borne     (literal)
 *
 *   DD → /api/notes/dd?noteId={uuid}                                      (~2 KB) — GroupDescription
 *      + /api/Notes/{uuid}/details/optimized?sectorId={X}                 (~150 KB-1.6 MB) — Activities[]
 *      • Activities[?].Code "C93"    → Subs Ramal       (Quantity)
 *      • Activities[?].Code "BTZ013" → Substituição CS  (Quantity)
 *      • else                         → DD Outros
 *
 * Subcategorias canônicas:
 *   sub_code        sub_categoria        tipo
 *   ─────────────────────────────────────────
 *   OBSOLETO        Subs Obsoleto        MD
 *   TL11            Subs TL11            MD
 *   L0              Corte Disjuntor      SF
 *   L1              Corte Borne          SF
 *   C93             Subs Ramal           DD   (com quantidade)
 *   BTZ013          Substituição CS      DD   (com quantidade)
 *   OUTROS          {Tipo} Outros        qualquer (fallback)
 */

const { wpaFetch } = require('./wpaService');
const { ehFalhaDeCaminho } = require('./wpaErros');

// ── helpers ──────────────────────────────────────────────────────────────────

// Sentinela pra distinguir "fetch FALHOU" (transiente: timeout, cold-start
// Azure, HTTP != 2xx) de "respondeu OK mas sem o campo esperado" (definitivo).
// Sem essa distinção, um timeout na classificação gravava OUTROS/sem-motivo
// PERMANENTE — o UUID entrava no cache e nunca era retentado (bug P1-7).
// Classificadores devolvem null quando o fetch PRIMÁRIO retorna FETCH_FAILED,
// deixando o UUID fora do cache pra retentar de graça no ciclo seguinte.
const FETCH_FAILED = Symbol('fetch_failed');

async function safeJson(path) {
  try {
    const res = await wpaFetch(path);
    return await res.json();
  } catch (err) {
    // 24/10/2026: o wpaFetch agora LANÇA WpaAccessError em qualquer status fora
    // de 2xx (spec wpa-acesso-edp.md). Distingue transiente de definitivo:
    //   404             → recurso ausente / definitivo → null (classifica como "sem dados")
    //   resto (5xx, 401, 403, 429, rede, JSON inválido) → FETCH_FAILED (retenta)
    //   caminho (proxy fora, IP bloqueado) → LANÇA: o lote inteiro para, uma
    //     linha de log no job — não adianta tentar nota por nota.
    // O bug P1-7 era timeout/cold-start (5xx e erro de rede) gravando OUTROS
    // permanente; 404 legítimo não deve gerar retry infinito. Antes, QUALQUER 4xx
    // virava null — 401/403 depois do relogin gravavam OUTROS em definitivo.
    if (ehFalhaDeCaminho(err)) throw err;
    if (err && err.status === 404) return null;
    return FETCH_FAILED;
  }
}

// Texto padrão do Comments da MD gerada pela II quando o medidor precisa ser
// trocado por um REMOTO: "* Instalar remota, realizar inspecao, testar
// comunicacao e registrar atendimento junto ao CIM. Se nao for possivel instalar
// remota, informar o motivo no texto da nota." (nota 045006483560, 09/10/2026).
// Casa só o trecho fixo "instalar remota", tolerando caixa e espaços.
const RE_MD_REMOTA = /instalar\s+remota/i;

function nomeFallback(tipo) {
  return `${tipo} Outros`;
}

// ── classificadores por tipo ─────────────────────────────────────────────────

/**
 * Classifica MD: Subs Obsoleto vs Subs TL11.
 *
 * Regra canônica (planilha de subcategorias da área de negócio, abr/2026):
 *   MD + Code "SPEB" + Comments contém "TL11" → Subs TL11
 *   MD + Code "SPEB" + Comments sem "TL11"   → Subs Obsoleto
 *   MD com outro Code                         → MD Outros
 *
 * Validação manual com 2 notas de exemplo:
 *   - 045006163408 (TL11): Comments = "* DATA HORA USUARIO* Tratativa de TL11"
 *   - 045006267560 (OBSOLETO): Comments = "* DATA HORA USUARIO* Projeto substituicao de medidores..."
 *
 * Endpoints (lazy fetch — só busca o pesado quando necessário):
 *   1. /api/notes/md?noteId={id}  (~2 KB) — Code, CodeText
 *      • Se Code != "SPEB" → OUTROS, retorna direto (sem 2ª chamada)
 *   2. /api/Notes/{id}/details/optimized?sectorId={X}  (~50-150 KB) — Comments
 *      • Só para SPEB. Comments NÃO existe no /api/notes/md (campos: Code,
 *        CodeText, MeasureCode, etc — sem campo de texto livre).
 *
 * Detalhes:
 *   - Comments tem cabeçalho automático "* DATA HORA USUARIO (ID)*" antes do
 *     texto livre. O regex /TL11/i é case-insensitive e cobre variações como
 *     "Tratativa de TL11", "Trativa de TL11" (typo da planilha), ou só "TL11".
 *   - CodeText "Substituição Projetos Especiais" é doublecheck — toda MD/SPEB
 *     deveria ter esse texto. Não usado como discriminador.
 *   - Versão anterior usava /api/notepriorities → SubProject. Removido pq
 *     a área de negócio padronizou Comments como fonte única e estável.
 */
async function classificarMD(noteId, sectorId) {
  const md = await safeJson(`/api/notes/md?noteId=${noteId}`);
  // Fetch primário falhou → não classifica agora (retenta no próximo ciclo).
  if (md === FETCH_FAILED) return null;

  const code     = md?.Data?.Code     || null;
  const codeText = md?.Data?.CodeText || null;

  // Comments NÃO está em /api/notes/md (verificado via diagnostic),
  // está só em /details/optimized.
  //
  // 14/10/2026: antes, Code != SPEB saía daqui sem chamar o details (lazy fetch).
  // Agora TODA MD busca o Comments, porque a MD de MEDIDOR REMOTO (gerada na hora
  // por uma II que exige trocar o medidor) NÃO é SPEB — o único sinal dela é o
  // texto padrão "* Instalar remota, realizar inspecao, testar comunicacao...".
  // Custo: 1 chamada extra por UUID de MD, uma vez só (resultado vai pro cache).
  const det = await safeJson(`/api/Notes/${noteId}/details/optimized?sectorId=${sectorId || 'DESG'}`);
  // Se o details falhou, NÃO temos como discriminar (SPEB: TL11 vs OBSOLETO;
  // outras: remota vs OUTROS) — retorna null pra retentar, senão gravaria
  // OUTROS/OBSOLETO por default e o UUID entraria no cache pra sempre (P1-7).
  if (det === FETCH_FAILED) return null;
  const comments = det?.Data?.Comments || '';

  if (code !== 'SPEB') {
    // MD de medidor remoto: 1 medidor por nota (confirmado pelo José, 14/10/2026).
    // Para a EDP o que importa é a quantidade de medidores, não de notas — por isso
    // grava `quantidade` (o mesmo mecanismo do Subs Ramal / Sub CS).
    if (RE_MD_REMOTA.test(comments)) {
      return {
        sub_code:      'REMOTA',
        sub_categoria: 'Subs Medidor Remoto',
        code, code_text: codeText, quantidade: 1,
        raw: { md: md?.Data ?? null, comments: comments.slice(0, 300) },
      };
    }
    return {
      sub_code:      'OUTROS',
      sub_categoria: nomeFallback('MD'),
      code, code_text: codeText, quantidade: null,
      raw: { md: md?.Data ?? null },
    };
  }

  // SPEB → Comments discrimina TL11 vs OBSOLETO.
  const isTL11 = /TL11/i.test(comments);
  return {
    sub_code:      isTL11 ? 'TL11'      : 'OBSOLETO',
    sub_categoria: isTL11 ? 'Subs TL11' : 'Subs Obsoleto',
    code, code_text: codeText, quantidade: null,
    raw: { md: md?.Data ?? null, comments: comments.slice(0, 300) },
  };
}

/**
 * Classifica SF: Corte Disjuntor (SRED) vs Corte Borne (SREB).
 * Tenta SFDL (SF local) primeiro; se vier sem Code, tenta SFRL (SF remoto —
 * maioria dos casos, ex: corte por inadimplência).
 * Demais Codes (CREB, CRED, ...) caem em "SF Outros" (regra literal).
 */
async function classificarSF(noteId) {
  // SFDL (Local) — para SFs onde a equipe vai ao local
  let sf = await safeJson(`/api/notes/sfdl?noteId=${noteId}`);
  let endpoint = 'sfdl';
  const sfdlFalhou = sf === FETCH_FAILED;

  // SFRL (Remote) — para SFs com corte/religação remotos
  if (sfdlFalhou || !sf?.Data?.Code) {
    const sfrl = await safeJson(`/api/notes/sfrl?noteId=${noteId}`);
    // Ambos os fetches falharam → não classifica agora (retenta no próximo ciclo)
    if (sfdlFalhou && sfrl === FETCH_FAILED) return null;
    if (sfrl !== FETCH_FAILED && sfrl?.Data?.Code) { sf = sfrl; endpoint = 'sfrl'; }
    else if (sfdlFalhou && sfrl !== FETCH_FAILED) { sf = sfrl; endpoint = 'sfrl'; }
  }

  const code     = sf?.Data?.Code     || null;
  const codeText = sf?.Data?.CodeText || null;

  let sub_code, sub_categoria;
  if (code === 'SRED')      { sub_code = 'L0';     sub_categoria = 'Corte Disjuntor'; }
  else if (code === 'SREB') { sub_code = 'L1';     sub_categoria = 'Corte Borne'; }
  else                      { sub_code = 'OUTROS'; sub_categoria = nomeFallback('SF'); }

  return {
    sub_code, sub_categoria, code, code_text: codeText, quantidade: null,
    raw: { [endpoint]: sf?.Data ?? null },
  };
}

/**
 * Classifica DD: Subs Ramal (C93) vs Substituição CS (BTZ013).
 * A classificação correta vem de Activities[].Code — campo só presente em
 * details/optimized. O endpoint notes/dd é leve mas o GroupDescription é
 * impreciso (ex: "BF-CHAVE FUSIVEL" não é Substituição de CS).
 *
 * Estratégia:
 *   1. notes/dd → metadados básicos (GroupCode/GroupDescription) para code_text
 *   2. details/optimized → Activities[] para encontrar C93 ou BTZ013
 *      (descartamos checkpoints/fotos no raw — só guardamos os campos relevantes)
 */
async function classificarDD(noteId, sectorId) {
  const [dd, detRaw] = await Promise.all([
    safeJson(`/api/notes/dd?noteId=${noteId}`),
    safeJson(`/api/Notes/${noteId}/details/optimized?sectorId=${sectorId || 'DESG'}`),
  ]);
  // dd é o fetch primário (define o tipo). Falhou → retenta no próximo ciclo.
  if (dd === FETCH_FAILED) return null;
  // det é secundário (traz Activities/Amount): se falhou, degrada pra
  // classificação por Code top-level (prioridade 2/3) — não é motivo de retry.
  const det = detRaw === FETCH_FAILED ? null : detRaw;

  // Campos do /api/notes/dd: Code (note-level), GroupCode, GroupDescription
  const noteCode  = dd?.Data?.Code             || null;  // ex: 'C93' direto na nota
  const groupCode = dd?.Data?.GroupCode        || null;
  const groupDesc = dd?.Data?.GroupDescription || '';

  // Atividades do details/optimized (mais confiável quando presente, traz Amount)
  const activities = det?.Data?.Activities || [];
  // Comments: texto livre da nota (template @MANUTBTZERO em BTZ013). Guardado só
  // como preview no raw (debug). NÃO é mais usado pra quantidade do BTZ013 — a
  // quantidade agora vem de Activity.Amount (ver bloco BTZ013 abaixo; 23/07/2026).
  const comments = det?.Data?.Comments || '';

  // Address: regra de negócio EDP — só notas com "RAMAL BT" no endereço contam
  // como Subs Ramal. Notas DD com Activity C93 mas SEM "Ramal BT" no Address
  // são outras manutenções de ramal (não-BT) e não devem inflar o indicador.
  // Confirmado em campo (20/05/2026, Clarissa @engelmig): regra usada pela EDP no BI.
  const address  = det?.Data?.Address || '';
  const isRamalBT = /ramal\s+bt/i.test(address);

  // Estrutura: { Activity: { Code, Description, ... }, Amount, IsPrimary, ... }
  // Prioriza atividade primária (IsPrimary=true) — uma nota pode ter várias secundárias.
  const findByCode = (code) =>
    activities.find(a => a.Activity?.Code === code && a.IsPrimary) ||
    activities.find(a => a.Activity?.Code === code);
  const ativC93    = findByCode('C93');
  const ativBTZ013 = findByCode('BTZ013');

  let sub_code, sub_categoria, quantidade = null;

  // ── 1ª PRIORIDADE: Activities[] (mais preciso, traz Amount real) ──────────
  // C93 só é considerada Subs Ramal se Address contém "RAMAL BT" (regra EDP).
  if (ativC93 && isRamalBT) {
    sub_code      = 'C93';
    sub_categoria = 'Subs Ramal';
    quantidade    = ativC93.Amount ?? null;        // C93 = qtd de ramais executados
  } else if (ativBTZ013) {
    sub_code      = 'BTZ013';
    sub_categoria = 'Substituição CS';
    // Quantidade = a "Quantidade" da Atividade no portal WPA = Activity.Amount
    // (nº de CS substituídos; 1 por nota). CORRIGIDO 23/07/2026 — confirmado
    // com o portal WPA (tela "Atividade Principal — BTZ013 · Quantidade: 1").
    //
    // HISTÓRICO (05/05/2026, SUPERSEDED em 23/07/2026): a regra anterior usava
    // parseTotalClientes(Comments) ("TOTAL CLIENTES: N"), assumindo N = nº de CS.
    // Estava ERRADO: "TOTAL CLIENTES" é o nº de CLIENTES ligados à CS, não a
    // produção executada — inflava o indicador (1 CS aparecia como "12").
    quantidade = ativBTZ013.Amount ?? 1;
  } else {
    sub_code      = 'OUTROS';
    sub_categoria = nomeFallback('DD');
  }

  // ── 2ª PRIORIDADE: Code top-level / GroupCode ────────────────────────────
  // Usado quando Activities[] vem vazio (ex: notas CAPEX). C93 = Subs Ramal,
  // BTZ013 = Substituição CS — mapeamento 1:1 oficial da WPA.
  // C93 ainda exige "RAMAL BT" no Address (regra EDP).
  if (sub_code === 'OUTROS') {
    const c = (noteCode || groupCode || '').toUpperCase();
    if (c === 'C93' && isRamalBT) {
      sub_code = 'C93';
      sub_categoria = 'Subs Ramal';
    } else if (c === 'BTZ013') {
      sub_code = 'BTZ013';
      sub_categoria = 'Substituição CS';
      // Sem Activities pra ler o Amount → 1 CS por nota (ver bloco BTZ013 acima).
      quantidade = ativBTZ013?.Amount ?? 1;
    }
  }

  // ── 3ª PRIORIDADE: GroupDescription ANCORADA (notas CAPEX) ───────────────
  // Confirmado em prod (12/05/2026): notas CAPEX vêm com:
  //   - Code: undefined no payload
  //   - GroupCode: número arbitrário (ex: "000000000000000058")
  //   - Activities: []
  //   - GroupDescription: formato estruturado "<TIPO> - CAPEX|OPEX"
  //     Ex: "RAMAL DE LIGACAO - CAPEX", "PODA DE ARVORES - OPEX"
  // Esse é o ÚNICO sinal disponível pra classificar nota CAPEX.
  // Regex ancorada no INÍCIO (^) pra evitar falsos positivos.
  // C93 ainda exige "RAMAL BT" no Address (regra EDP).
  if (sub_code === 'OUTROS') {
    const desc = (groupDesc || '').toUpperCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/^RAMAL\s+DE\s+LIGAC/.test(desc) && isRamalBT) {
      sub_code = 'C93';
      sub_categoria = 'Subs Ramal';
    } else if (/^CAIXA\s+SECCION/.test(desc) || /^SUBSTITU.*\bCS\b/.test(desc)) {
      sub_code = 'BTZ013';
      sub_categoria = 'Substituição CS';
      quantidade = ativBTZ013?.Amount ?? 1;   // sem Activities → 1 CS por nota
    }
  }

  // Guarda apenas campos relevantes no raw — descarta photos/checkpoints (1.6 MB)
  const activitiesLight = activities.map(a => ({
    Code:      a.Activity?.Code      ?? null,
    Amount:    a.Amount              ?? null,
    IsPrimary: a.IsPrimary           ?? null,
  }));

  return {
    sub_code, sub_categoria,
    code:      noteCode || groupCode,        // prefere Code; cai pra GroupCode
    code_text: groupDesc,
    quantidade,
    raw: {
      dd: dd?.Data ?? null,
      activities: activitiesLight,
      // Snippet do Comments (preview pra debug, sem armazenar texto longo)
      comments_preview: comments ? comments.slice(0, 200) : null,
    },
  };
}

// (parseTotalClientes — extraía "TOTAL CLIENTES: N" do Comments pra quantidade
//  do BTZ013 — REMOVIDA em 23/07/2026. Era a regra errada: "TOTAL CLIENTES" é
//  nº de clientes, não de CS. Agora BTZ013.quantidade = Activity.Amount. Git
//  guarda a implementação antiga.)

// ── REJEIÇÃO (motivos canônicos da WPA) ──────────────────────────────────────

/**
 * Mapa tipo → endpoint do WPA que retorna `Rejection.RejectionReasons[]`.
 * Confirmado em prod (23/05/2026): /api/notes/md, /sfrl, /dd têm o campo.
 */
const REJECTION_ENDPOINT_BY_TIPO = {
  MD: '/api/notes/md',
  SF: '/api/notes/sfrl',   // SF remoto — fallback sfdl se necessário
  DD: '/api/notes/dd',
  LN: '/api/notes/ln',
  LE: '/api/notes/le',
  DL: '/api/notes/dl',
  RL: '/api/notes/rl',
};

/**
 * Classifica uma nota REJEITADA — extrai motivos canônicos do WPA.
 *
 * Fonte: /api/notes/{tipo}?noteId=... → Rejection.RejectionReasons[]
 *   [{ Code, Description, EntityId, Label, ... }, ...]
 *
 * Uma nota pode ter VÁRIOS motivos. Retornamos arrays paralelos.
 * Cerca de 60% das "rejeitadas" do snapshot não têm Rejection populado
 * (são bandeiradas tipo Conta Paga) — nesses casos retorna arrays vazios
 * e mantemos o registro pra rankear "Sem motivo registrado" no UI.
 *
 * @param {string} noteId   UUID
 * @param {string} tipo     'MD' | 'SF' | 'DD' | 'LN' | 'LE' | 'DL' | 'RL'
 * @returns {object}        { reason_codes, reason_labels, raw }
 */
async function classificarRejeicao(noteId, tipo) {
  const t = String(tipo || '').toUpperCase();
  const endpoint = REJECTION_ENDPOINT_BY_TIPO[t];
  if (!endpoint) return { reason_codes: [], reason_labels: [], raw: null };

  const j = await safeJson(`${endpoint}?noteId=${noteId}`);
  const rej = j?.Data?.Rejection;
  if (!rej || !Array.isArray(rej.RejectionReasons) || rej.RejectionReasons.length === 0) {
    // SF: se sfrl veio vazio, tenta sfdl (SF local)
    if (t === 'SF') {
      const j2 = await safeJson(`/api/notes/sfdl?noteId=${noteId}`);
      const rej2 = j2?.Data?.Rejection;
      if (rej2 && Array.isArray(rej2.RejectionReasons) && rej2.RejectionReasons.length > 0) {
        return _extrairMotivos(rej2);
      }
    }
    return { reason_codes: [], reason_labels: [], raw: rej || null };
  }
  return _extrairMotivos(rej);
}

function _extrairMotivos(rej) {
  const reasons = Array.isArray(rej.RejectionReasons) ? rej.RejectionReasons : [];
  const codes  = reasons.map(r => r.Code).filter(Boolean);
  const labels = reasons.map(r => r.Description || r.Label || r.Code).filter(Boolean);
  return { reason_codes: codes, reason_labels: labels, raw: rej };
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Classifica uma nota individual.
 * @param {string} noteId  UUID da nota
 * @param {string} tipo    'MD' | 'SF' | 'DD' (vem do V2/sessions)
 * @param {object} ctx     { sectorId, numero, comments? }
 * @returns {object|null}  { sub_code, sub_categoria, code, code_text, quantidade, raw }
 *                         ou null se tipo não classificável
 */
async function classificar(noteId, tipo, ctx = {}) {
  if (!noteId || !tipo) return null;
  const t = String(tipo).toUpperCase();
  let result;
  if (t === 'MD')      result = await classificarMD(noteId, ctx.sectorId);
  else if (t === 'SF') result = await classificarSF(noteId);
  else if (t === 'DD') result = await classificarDD(noteId, ctx.sectorId);
  else return null;

  // result null = fetch transiente falhou (P1-7) → propaga null pra que o
  // caller (classificarBatch) filtre o UUID e retente no próximo ciclo, em
  // vez de gravar classificação incompleta/errada no cache.
  if (!result) return null;

  return {
    note_id:       noteId,
    numero:        ctx.numero || null,
    tipo:          t,
    ...result,
  };
}

/**
 * Classifica várias notas em paralelo controlado.
 *
 * Estratégia (memória):
 *   - DD dispara /details/optimized (150 KB-1.6 MB cada). Concorrência baixa (2)
 *     e processado SEPARADAMENTE de MD/SF — não em paralelo — pra evitar somar
 *     payloads pesados na heap.
 *   - Entre chunks, `await new Promise(r => setImmediate(r))` cede o event loop
 *     pro GC liberar o JSON.parse anterior. Sem isso, V8 acumula objetos até o
 *     pm2 matar por max_memory_restart (incidente 27/05/2026: 161 restarts).
 *
 * @param {Array<{noteId, tipo, sectorId?, numero?}>} jobs
 * @param {number} concurrency  default p/ MD/SF (DD é forçado a 2)
 * @returns {Promise<Array>}  classificações (filtra nulos)
 */
async function classificarBatch(jobs, concurrency = 6) {
  const ddJobs   = jobs.filter(j => j.tipo === 'DD');
  const lightJobs = jobs.filter(j => j.tipo !== 'DD');

  async function processar(items, conc) {
    const out = [];
    for (let i = 0; i < items.length; i += conc) {
      const chunk = items.slice(i, i + conc);
      // 24/10/2026: falha do CAMINHO até a EDP para o lote (não vira null por nota).
      const results = await Promise.all(chunk.map(j =>
        classificar(j.noteId, j.tipo, j).catch((err) => { if (ehFalhaDeCaminho(err)) throw err; return null; })
      ));
      for (const r of results) { if (r) out.push(r); }
      // Cede o event loop entre chunks → GC pode liberar o JSON do chunk anterior
      await new Promise(resolve => setImmediate(resolve));
    }
    return out;
  }

  // SEQUENCIAL (não Promise.all): evita somar MD/SF + DD em voo simultâneo.
  // MD/SF primeiro (leves, terminam rápido), depois DD (pesados, conc 2).
  const lightOut = await processar(lightJobs, concurrency);
  const ddOut    = await processar(ddJobs, 2);
  return [...lightOut, ...ddOut];
}

module.exports = { classificar, classificarBatch, classificarRejeicao, _safeJson: safeJson, _FETCH_FAILED: FETCH_FAILED };   // _ = só pra teste
