/**
 * services/classifierService.js
 * Classificador de subcategorias de notas WPA (MD, SF, DD).
 *
 * Estratégia (endpoints leves do WPA):
 *   MD → /api/notes/md?noteId={uuid}            (~2.6 KB) — Code, CodeText
 *      + /api/notepriorities/GetByNoteId/{uuid} (~1.6 KB) — SubProject (TL11/OBSOLETO)
 *   SF → /api/notes/sfdl?noteId={uuid}          (~2 KB)   — Code, CodeText
 *   DD → /api/notes/dd?noteId={uuid}            (~1.9 KB) — GroupCode, GroupDescription
 *        + details/optimized (só DD/C93|BTZ013) — Activities[].Quantity
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

// ── helpers ──────────────────────────────────────────────────────────────────

async function safeJson(path) {
  try {
    const res = await wpaFetch(path);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function nomeFallback(tipo) {
  return `${tipo} Outros`;
}

// ── classificadores por tipo ─────────────────────────────────────────────────

/**
 * Classifica MD: Subs Obsoleto vs Subs TL11.
 * Discriminador definitivo: notepriorities.SubProject ("OBSOLETO" | "TL11").
 * Fallback (caso priorities venha vazia): inspeciona Comments do details/optimized
 *   se já tivermos algum dado bruto cacheado — não dispara nova chamada pesada.
 */
async function classificarMD(noteId, hint = {}) {
  const [md, prio] = await Promise.all([
    safeJson(`/api/notes/md?noteId=${noteId}`),
    safeJson(`/api/notepriorities/GetByNoteId/${noteId}`),
  ]);

  const code      = md?.Data?.Code      || null;
  const codeText  = md?.Data?.CodeText  || null;
  const subProj   = prio?.Data?.SubProject;
  const comments  = hint.comments || md?.Data?.Comments || '';

  let sub_code, sub_categoria;
  if (subProj === 'TL11')          { sub_code = 'TL11';     sub_categoria = 'Subs TL11'; }
  else if (subProj === 'OBSOLETO') { sub_code = 'OBSOLETO'; sub_categoria = 'Subs Obsoleto'; }
  // Fallback heurístico via Comments (caso SubProject venha null)
  else if (/TL11/i.test(comments)) { sub_code = 'TL11';     sub_categoria = 'Subs TL11'; }
  else if (code === 'SPEB')        { sub_code = 'OBSOLETO'; sub_categoria = 'Subs Obsoleto'; }
  else                             { sub_code = 'OUTROS';   sub_categoria = nomeFallback('MD'); }

  return {
    sub_code, sub_categoria, code, code_text: codeText, quantidade: null,
    raw: { md: md?.Data ?? null, prio: prio?.Data ?? null },
  };
}

/**
 * Classifica SF: Corte Disjuntor (SRED) vs Corte Borne (SREB).
 * Demais Codes (CREB, CRED, ...) caem em "SF Outros".
 */
async function classificarSF(noteId) {
  const sf = await safeJson(`/api/notes/sfdl?noteId=${noteId}`);
  const code     = sf?.Data?.Code     || null;
  const codeText = sf?.Data?.CodeText || null;

  let sub_code, sub_categoria;
  if (code === 'SRED')      { sub_code = 'L0'; sub_categoria = 'Corte Disjuntor'; }
  else if (code === 'SREB') { sub_code = 'L1'; sub_categoria = 'Corte Borne'; }
  else                      { sub_code = 'OUTROS'; sub_categoria = nomeFallback('SF'); }

  return {
    sub_code, sub_categoria, code, code_text: codeText, quantidade: null,
    raw: { sfdl: sf?.Data ?? null },
  };
}

/**
 * Classifica DD: Subs Ramal (C93) vs Substituição CS (BTZ013).
 * Discriminador: GroupDescription contendo "RAMAL" ou "CS"/"CHAVE".
 * Quando bate em C93 ou BTZ013, busca Activities[].Quantity via details/optimized.
 */
async function classificarDD(noteId, sectorId) {
  const dd = await safeJson(`/api/notes/dd?noteId=${noteId}`);
  const groupCode = dd?.Data?.GroupCode        || null;
  const groupDesc = dd?.Data?.GroupDescription || '';
  const upper = groupDesc.toUpperCase();

  let sub_code, sub_categoria;
  if (/RAMAL/.test(upper))           { sub_code = 'C93';    sub_categoria = 'Subs Ramal'; }
  else if (/\bCS\b|CHAVE/.test(upper)){ sub_code = 'BTZ013'; sub_categoria = 'Substituição CS'; }
  else                                { sub_code = 'OUTROS'; sub_categoria = nomeFallback('DD'); }

  let quantidade = null;
  if (sub_code === 'C93' || sub_code === 'BTZ013') {
    const det = await safeJson(`/api/Notes/${noteId}/details/optimized?sectorId=${sectorId || 'DESG'}`);
    const ativ = (det?.Data?.Activities || []).find(a => a.Quantity != null);
    quantidade = ativ?.Quantity ?? null;
  }

  return {
    sub_code, sub_categoria, code: groupCode, code_text: groupDesc, quantidade,
    raw: { dd: dd?.Data ?? null },
  };
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
  if (t === 'MD')      result = await classificarMD(noteId, { comments: ctx.comments });
  else if (t === 'SF') result = await classificarSF(noteId);
  else if (t === 'DD') result = await classificarDD(noteId, ctx.sectorId);
  else return null;

  return {
    note_id:       noteId,
    numero:        ctx.numero || null,
    tipo:          t,
    ...result,
  };
}

/**
 * Classifica várias notas em paralelo controlado.
 * @param {Array<{noteId, tipo, sectorId?, numero?, comments?}>} jobs
 * @param {number} concurrency
 * @returns {Promise<Array>}  classificações (filtra nulos)
 */
async function classificarBatch(jobs, concurrency = 10) {
  const out = [];
  for (let i = 0; i < jobs.length; i += concurrency) {
    const chunk = jobs.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(j =>
      classificar(j.noteId, j.tipo, j).catch(() => null)
    ));
    results.forEach(r => { if (r) out.push(r); });
  }
  return out;
}

module.exports = { classificar, classificarBatch };
