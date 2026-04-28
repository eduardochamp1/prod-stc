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
 * Discriminador: notepriorities.SubProject — variantes começando com "TL11"
 * (ex: "TL11 Conv", "TL11 Tele") caem em Subs TL11. SubProject NULL em
 * notas SPEB cai em Subs Obsoleto (regra de negócio acordada).
 */
async function classificarMD(noteId) {
  const [md, prio] = await Promise.all([
    safeJson(`/api/notes/md?noteId=${noteId}`),
    safeJson(`/api/notepriorities/GetByNoteId/${noteId}`),
  ]);

  const code      = md?.Data?.Code      || null;
  const codeText  = md?.Data?.CodeText  || null;
  const subProj   = prio?.Data?.SubProject || null;

  let sub_code, sub_categoria;
  if (subProj && /^TL11/i.test(subProj))     { sub_code = 'TL11';     sub_categoria = 'Subs TL11'; }
  else if (subProj === 'OBSOLETO')           { sub_code = 'OBSOLETO'; sub_categoria = 'Subs Obsoleto'; }
  // SPEB sem SubProject definido → assume Obsoleto (regra do negócio)
  else if (code === 'SPEB')                  { sub_code = 'OBSOLETO'; sub_categoria = 'Subs Obsoleto'; }
  else                                       { sub_code = 'OUTROS';   sub_categoria = nomeFallback('MD'); }

  return {
    sub_code, sub_categoria, code, code_text: codeText, quantidade: null,
    raw: { md: md?.Data ?? null, prio: prio?.Data ?? null },
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

  // SFRL (Remote) — para SFs com corte/religação remotos
  if (!sf?.Data?.Code) {
    const sfrl = await safeJson(`/api/notes/sfrl?noteId=${noteId}`);
    if (sfrl?.Data?.Code) { sf = sfrl; endpoint = 'sfrl'; }
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
  const [dd, det] = await Promise.all([
    safeJson(`/api/notes/dd?noteId=${noteId}`),
    safeJson(`/api/Notes/${noteId}/details/optimized?sectorId=${sectorId || 'DESG'}`),
  ]);

  const groupCode = dd?.Data?.GroupCode        || null;
  const groupDesc = dd?.Data?.GroupDescription || '';

  const activities = det?.Data?.Activities || [];
  const ativC93    = activities.find(a => a.Code === 'C93');
  const ativBTZ013 = activities.find(a => a.Code === 'BTZ013');

  let sub_code, sub_categoria, quantidade = null;
  if (ativC93) {
    sub_code = 'C93';
    sub_categoria = 'Subs Ramal';
    quantidade = ativC93.Quantity ?? null;
  } else if (ativBTZ013) {
    sub_code = 'BTZ013';
    sub_categoria = 'Substituição CS';
    quantidade = ativBTZ013.Quantity ?? null;
  } else {
    sub_code = 'OUTROS';
    sub_categoria = nomeFallback('DD');
  }

  // Guarda apenas campos relevantes no raw — descarta photos/checkpoints (1.6 MB)
  const activitiesLight = activities.map(a => ({ Code: a.Code, Quantity: a.Quantity }));

  return {
    sub_code, sub_categoria,
    code:      groupCode,
    code_text: groupDesc,
    quantidade,
    raw: { dd: dd?.Data ?? null, activities: activitiesLight },
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
  if (t === 'MD')      result = await classificarMD(noteId);
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
 * Aplica concorrência menor para DD (que dispara details/optimized ~1.6 MB).
 * @param {Array<{noteId, tipo, sectorId?, numero?}>} jobs
 * @param {number} concurrency  default p/ MD/SF (DD é forçado a 4)
 * @returns {Promise<Array>}  classificações (filtra nulos)
 */
async function classificarBatch(jobs, concurrency = 10) {
  // Separa DD (pesado) de MD/SF (leve) e processa com concorrências diferentes
  const ddJobs   = jobs.filter(j => j.tipo === 'DD');
  const lightJobs = jobs.filter(j => j.tipo !== 'DD');

  async function processar(jobs, conc) {
    const out = [];
    for (let i = 0; i < jobs.length; i += conc) {
      const chunk = jobs.slice(i, i + conc);
      const results = await Promise.all(chunk.map(j =>
        classificar(j.noteId, j.tipo, j).catch(() => null)
      ));
      results.forEach(r => { if (r) out.push(r); });
    }
    return out;
  }

  // MD/SF (leve, ~2 KB): concorrência alta
  // DD (pesado, ~1.6 MB com fotos): concorrência baixa para não saturar
  const [lightOut, ddOut] = await Promise.all([
    processar(lightJobs, concurrency),
    processar(ddJobs, 4),
  ]);
  return [...lightOut, ...ddOut];
}

module.exports = { classificar, classificarBatch };
