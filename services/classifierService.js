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

  const code     = md?.Data?.Code     || null;
  const codeText = md?.Data?.CodeText || null;

  // Code != SPEB cai direto em OUTROS — evita chamada pesada ao details/optimized
  if (code !== 'SPEB') {
    return {
      sub_code:      'OUTROS',
      sub_categoria: nomeFallback('MD'),
      code, code_text: codeText, quantidade: null,
      raw: { md: md?.Data ?? null },
    };
  }

  // SPEB → precisa de Comments p/ discriminar TL11 vs OBSOLETO.
  // Comments NÃO está em /api/notes/md (verificado via diagnostic),
  // está só em /details/optimized.
  const det = await safeJson(`/api/Notes/${noteId}/details/optimized?sectorId=${sectorId || 'DESG'}`);
  const comments = det?.Data?.Comments || '';

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

  // Campos do /api/notes/dd: Code (note-level), GroupCode, GroupDescription
  const noteCode  = dd?.Data?.Code             || null;  // ex: 'C93' direto na nota
  const groupCode = dd?.Data?.GroupCode        || null;
  const groupDesc = dd?.Data?.GroupDescription || '';

  // Atividades do details/optimized (mais confiável quando presente, traz Amount)
  const activities = det?.Data?.Activities || [];
  // Comments: contém metadados textuais como "TOTAL CLIENTES: N" usado pra
  // determinar quantidade real de CS substituídos em BTZ013 (Activity.Amount
  // sempre vem 1, representa "1 ação de manutenção" — não conta CS individuais).
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
    // Pra BTZ013, Activity.Amount é sempre 1 (representa "1 ação de manutenção").
    // O número real de CS trocados está no Comments com o padrão "TOTAL CLIENTES: N".
    // Confirmado em prod (05/05/2026): nota 17160974 → Activity.Amount=1 mas
    // Comments tem "TOTAL CLIENTES: 6" → 6 CS efetivamente substituídos.
    quantidade = parseTotalClientes(comments);
    if (quantidade == null) quantidade = ativBTZ013.Amount ?? null;  // fallback legado
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
      // Sem Activities → tenta extrair quantidade do Comments também
      quantidade = parseTotalClientes(comments);
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
      quantidade = parseTotalClientes(comments);
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

/**
 * Extrai número de "TOTAL CLIENTES: N" do Comments da nota.
 * Padrão observado em produção (template @MANUTBTZERO):
 *   "* @MANUTBTZERO | CS_CP: ... | ... | TOTAL CLIENTES: 6 | @MANUTBTZERO"
 * Retorna null se não casar — caller deve fazer fallback.
 */
function parseTotalClientes(comments) {
  if (!comments) return null;
  const m = String(comments).match(/TOTAL\s*CLIENTES\s*:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
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
