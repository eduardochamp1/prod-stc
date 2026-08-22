/**
 * services/notaProcessor.js
 * Transforma o payload bruto da WPA (`/api/Notes/{id}/details/optimized`) em
 * um JSON enxuto para o front-end. Compartilhado entre a rota /api/wpa/nota
 * (chamada ao vivo) e o cron de caching (popula `note_details` no Supabase).
 *
 * Por padrão NÃO inclui fotos em base64 (pesa MB por checkpoint). Passar
 * `{ incluirFotos: true }` apenas em chamadas explícitas com `?fotos=1` —
 * essas NUNCA são gravadas em cache.
 */

/**
 * Concatena 'Z' em timestamps ISO sem TZ marker. EDP retorna timestamps em UTC
 * mas sem 'Z' (ex: "2026-06-08T14:31:00"), o que faz o JS interpretar como
 * local time, mostrando horários 3h adiantados. Mesmo fix aplicado em
 * wpaService.normalizarNotaV2 (08/06/2026) e rejectionService (07/06).
 *
 * Note: campos '*Date2' geralmente vêm em DD/MM/YYYY (BR) — não tocamos.
 */
function _normTz(s) {
  if (!s || typeof s !== 'string') return s;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;          // não é ISO
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) return s;        // já tem TZ
  return s + 'Z';
}

/**
 * "DD/MM/YYYY HH:MM(:SS)" (formato dos campos `*2` da EDP) → ISO com offset BRT.
 * Qualquer outra coisa passa intacta. Não desloca o instante: o valor BR já é
 * hora local de São Paulo (conferido contra o TimeStamp UTC na KB).
 * Adicionado em 20/08/2026 junto do P1-28.
 */
function _brToIso(s) {
  if (!s || typeof s !== 'string') return s;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return s;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss || '00'}-03:00`;
}

/**
 * @param {object} nota   Payload bruto vindo de getNoteDetail()
 * @param {object} opts   { incluirFotos?: boolean, subcat?: object }
 * @returns {object}      Resposta normalizada para o front
 */
function processarNota(nota, opts = {}) {
  const incluirFotos = !!opts.incluirFotos;
  const subcat       = opts.subcat || { subCategoria: null, subcatCode: null, quantidade: null };

  // Checkpoints ordenados cronologicamente; fotos só vão se solicitado.
  //
  // 20/08/2026 (backlog P1-28): a ordenação e o `timestamp` abaixo preferiam
  // `RegisteredAt2`, contra a regra escrita neste mesmo arquivo (ver bloco
  // `datas:`) — cp.TimeStamp é campo do APP MÓVEL, cuja versão 2 está corrompida.
  // E `*Date2` vem em DD/MM/YYYY (BR), como o comentário do _normTz já dizia:
  // `new Date("15/08/2026 14:23")` é Invalid Date, então de dia 13 a 31 esta
  // ordenação era um no-op e `dispMin`/`execMin` do card viravam NaN
  // (`NaN !== null` passa o guard de render → "🚗 NaNmin").
  const _cpTs = cp => _normTz(cp.TimeStamp) || _brToIso(cp.RegisteredAt2);
  const checkpoints = (nota.Checkpoints || [])
    .sort((a, b) => new Date(_cpTs(a)) - new Date(_cpTs(b)))
    .map(cp => {
      const fotos = (cp.FileWrappers || []).map((fw, idx) => ({
        index:    idx,
        base64:   incluirFotos ? fw.Base64 : undefined,
        hasImage: Boolean(fw.Base64),
      }));
      return {
        id:          cp.Id,
        event:       cp.Event,
        // cp.Try é a TENTATIVA do checkpoint (1..6 medido em 21/08/2026), distinta de
        // nota.Try em `operacional.tentativa`. Vinha de graça no details/optimized e
        // era descartada; a análise de deslocamento inferia a tentativa por "cada
        // novo event=0". 0 é valor legítimo, então só ausência vira null.
        tentativa:   cp.Try === undefined || cp.Try === null ? null : cp.Try,
        timestamp:   _cpTs(cp),                 // P1-28 — UTC primeiro, BR só como fallback
        mileage:     cp.Mileage,
        latitude:    cp.Latitude,
        longitude:   cp.Longitude,
        battery:     cp.BatteryLevel,
        accuracy:    cp.Accuracy,
        fotosCount:  fotos.length,
        fotos:       incluirFotos ? fotos : undefined,
      };
    });

  const equipamentos = (nota.Equipments || []).map(e => ({
    id:          e.Id,
    equipmentId: e.EquipmentId,
    model:       e.Model,
    serialNumber:e.SerialNumber,
    prefix:      e.Prefix,
    materialNumber: e.MaterialNumber,
    installation: e.Installation,
    constructionClass: e.ConstructionClass,
    flagMainMeterRemoved:      e.FlagMainMeterRemoved,
    flagEquipmentSubstitution: e.FlagEquipmentSubstitution,
  }));

  const lacres = (nota.Seals || []).map(s => ({
    id:                s.Id,
    sealId:            s.SealId,
    sealNumber:        s.SealNumber,
    sealType:          s.SealType,
    sequenceNumber:    s.SequenceNumber,
    registryTypeId:    s.RegistryTypeId,
    installation:      s.Installation,
    flagRemoved:       s.FlagRemoved,
    flagNoCover:       s.FlagNoCover,
    flagNoDevice:      s.FlagNoDevice,
    flagDivergentSeal: s.FlagDivergentSeal,
  }));

  return {
    id:              nota.Id,
    numero:          nota.Number,
    codigo:          nota.Code,
    tipo:            nota.Type,
    subCategoria:    subcat.subCategoria,
    subcatCode:      subcat.subcatCode,
    quantidadeExec:  subcat.quantidade,
    status:          nota.Status,
    executionStatus: nota.ExecutionStatus,
    cliente: {
      nome:            nota.CustomerName,
      telefone:        nota.CustomerPhone,
      unidade:         nota.ConsumerUnit,
      medidor:         nota.MeterSerialNumber,
      tensao:          nota.Voltage,
      tarifaCategoria: nota.RateCategory,
    },
    endereco: {
      logradouro: nota.Address,
      bairro:     nota.Neighborhood,
      cidade:     nota.City,
      cep:        nota.ZipCode,
      latitude:   nota.Latitude,
      longitude:  nota.Longitude,
    },
    datas: {
      // EDP é INCONSISTENTE no formato das datas:
      //   - Campos GERADOS PELA EDP (Issue, Desired, Import, Creation):
      //     a versão 2 (com offset -03:00) está corretamente convertida → preferimos.
      //   - Campos VINDOS DO APP MÓVEL (Conclusion, Timestamp, cp.TimeStamp):
      //     a versão 2 está CORROMPIDA — a EDP cola "-03:00" no fim da string UTC
      //     sem converter o valor, fazendo o instante ficar 3h adiantado.
      // Probe confirmou em 08/06/2026: ConclusionDate=14:27 (UTC, real 11:27 BRT)
      // mas ConclusionDate2=14:27-03:00 (= 14:27 BRT, errado por 3h).
      // Solução: usa SÓ a versão UTC (sem 2) pros campos do app + _normTz pra
      // marcar com Z, e mantém a versão 2 pros campos da EDP que estão corretos.
      emissao:         nota.IssueDate2             || _normTz(nota.IssueDate),
      desejada:        nota.DesiredConclusionDate2 || _normTz(nota.DesiredConclusionDate),
      conclusao:       _normTz(nota.ConclusionDate),  // NUNCA usar ConclusionDate2 — corrompido
      statusConclusao: nota.ConclusionStatus,
      importacao:      nota.ImportDate2            || _normTz(nota.ImportDate),
    },
    operacional: {
      workCenter:     nota.WorkCenter,
      gpm:            nota.GPM,
      teamId:         nota.TeamId,
      sectorId:       nota.SectorId,
      tentativa:      nota.Try,
      isHighPriority: nota.isHighPriorityNote,
    },
    codificacao: {
      grupoCodificacao: nota.NoteMeasurementTypeProposed || null,
      codificacao:      nota.Code,
      codigoMedidas:    nota.NoteMeasurementType,
      unidadeLeitura:   nota.ReadUnit,
      instalacao:       nota.InstallationId,
      dataCriacao:      nota.CreationDate2 || _normTz(nota.CreationDate),
      statusSurvey:     nota.StatusSurvey  || null,
    },
    texto:       nota.Text,
    comentarios: nota.Comments,
    checkpoints,
    equipamentos,
    lacres,
    materiais:  (nota.Materials  || []).length,
    atividades: (nota.Activities || []).length,
    checklists: (nota.Checklists || []).length,
  };
}

/**
 * Heurística de subcategoria — espelha exatamente classifierService.classificar()
 * para casos em que já temos o payload completo da nota em mãos (sem fazer
 * chamadas extras à WPA). Usada como fallback quando `note_subcategorias` ainda
 * não tem o resultado, e na rota /api/wpa/nota.
 *
 * IMPORTANTE: para nada divergir do classificador autoritativo, retornamos
 * sempre 'OUTROS' nos ramos else (em vez de devolver o code original) e
 * aplicamos o mesmo fallback de "RAMAL DE LIGACAO" para DD com Activities=[].
 *
 * @param {string} tipo               'MD' | 'SF' | 'DD' | outros
 * @param {string} code               Code da nota (SRED/SREB/SPEB/...)
 * @param {string} comments           Comments (texto livre)
 * @param {Array}  activities         Activities[] do details/optimized
 * @param {string} [groupDescription] GroupDescription de /api/notes/dd (opcional, melhora DD)
 * @param {string} [address]          Address da nota — usado pra exigir "RAMAL BT" em C93
 */
function classificarSubCategoria(tipo, code, comments, activities, groupDescription, address) {
  const act = activities || [];

  if (tipo === 'SF') {
    if (code === 'SRED') return { subCategoria: 'Corte Disjuntor', subcatCode: 'L0', quantidade: null };
    if (code === 'SREB') return { subCategoria: 'Corte Borne',     subcatCode: 'L1', quantidade: null };
    return { subCategoria: 'SF Outros', subcatCode: 'OUTROS', quantidade: null };
  }

  if (tipo === 'MD') {
    if (code === 'SPEB') {
      const isTL11 = (comments || '').toUpperCase().includes('TL11');
      return {
        subCategoria: isTL11 ? 'Subs TL11' : 'Subs Obsoleto',
        subcatCode:   isTL11 ? 'TL11'      : 'OBSOLETO',
        quantidade:   null,
      };
    }
    return { subCategoria: 'MD Outros', subcatCode: 'OUTROS', quantidade: null };
  }

  if (tipo === 'DD') {
    // Estratégia: usar SOMENTE campos determinísticos (Activities[] + Code).
    // Texto livre foi descartado — sujeito a variações de grafia.

    // Regra de negócio EDP: C93 (Subs Ramal) só conta se Address contém "RAMAL BT".
    // Sem isso, mesmo com Activity C93 a nota é outra manutenção (não inflate).
    const isRamalBT = /ramal\s+bt/i.test(address || '');

    // 1ª prioridade: Activities[] (mais preciso, com Amount real)
    const findByCode = (c) =>
      act.find(a => a.Activity?.Code === c && a.IsPrimary) ||
      act.find(a => a.Activity?.Code === c);
    const ativC93    = findByCode('C93');
    const ativBTZ013 = findByCode('BTZ013');
    if (ativC93 && isRamalBT)
      return { subCategoria: 'Subs Ramal', subcatCode: 'C93', quantidade: ativC93.Amount ?? null };
    if (ativBTZ013)
      return { subCategoria: 'Substituição CS', subcatCode: 'BTZ013', quantidade: ativBTZ013.Amount ?? null };

    // 2ª prioridade: code top-level da nota (mapeamento 1:1 oficial WPA)
    const c = String(code || '').toUpperCase();
    if (c === 'C93' && isRamalBT)
      return { subCategoria: 'Subs Ramal', subcatCode: 'C93', quantidade: null };
    if (c === 'BTZ013')
      return { subCategoria: 'Substituição CS', subcatCode: 'BTZ013', quantidade: null };

    // 3ª prioridade: GroupDescription ancorada (notas CAPEX sem Code nem Activities)
    // Formato estruturado da EDP: "<TIPO> - CAPEX|OPEX"
    // Match ancorado no INÍCIO pra evitar falsos positivos.
    const desc = String(groupDescription || '').toUpperCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/^RAMAL\s+DE\s+LIGAC/.test(desc) && isRamalBT) {
      return { subCategoria: 'Subs Ramal', subcatCode: 'C93', quantidade: null };
    }
    if (/^CAIXA\s+SECCION/.test(desc) || /^SUBSTITU.*\bCS\b/.test(desc)) {
      return { subCategoria: 'Substituição CS', subcatCode: 'BTZ013', quantidade: null };
    }

    return { subCategoria: 'DD Outros', subcatCode: 'OUTROS', quantidade: null };
  }

  // Outros tipos não tem subcategorização — retornam OUTROS para alinhar com
  // o classifier (que sempre retorna sub_code definido, nunca null/code original)
  return { subCategoria: null, subcatCode: 'OUTROS', quantidade: null };
}

/**
 * Aplica _normTz nos campos conhecidos de um payload JÁ processado (vindo do
 * cache note_details). Necessário pra corrigir timestamps gravados antes do fix
 * de TZ (08/06/2026). Mutação in-place — só usar em copia ou payload descartavel.
 */
/**
 * conclusao em caches antigos foi gravado a partir de ConclusionDate2 que vinha
 * CORROMPIDO da EDP (string UTC + "-03:00" falso colado). O _normTz normal não
 * detecta — vê o offset e assume que está OK.
 *
 * Aqui detectamos o padrão "...HH:MM:SS-03:00" e substituímos por "...HH:MM:SSZ"
 * — assumindo que o valor original era UTC e o offset foi colado por engano.
 * Caches gravados a partir do commit 0781f49 (08/06/2026) já vêm com Z, então
 * essa transformação é noop pra eles.
 */
function _fixConclusaoCorrompida(s) {
  if (!s || typeof s !== 'string') return s;
  // ISO com offset -03:00 → assumir corrompido, trocar por Z (UTC)
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+-03:00$/.test(s)) {
    return s.replace(/-03:00$/, 'Z');
  }
  return _normTz(s);
}

function fixCachedPayloadTz(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.datas) {
    payload.datas.emissao    = _normTz(payload.datas.emissao);
    payload.datas.desejada   = _normTz(payload.datas.desejada);
    // conclusao precisa do tratamento especial — caches antigos tinham
    // ConclusionDate2 (offset -03:00 corrompido) gravado.
    payload.datas.conclusao  = _fixConclusaoCorrompida(payload.datas.conclusao);
    payload.datas.importacao = _normTz(payload.datas.importacao);
  }
  if (payload.codificacao) {
    payload.codificacao.dataCriacao = _normTz(payload.codificacao.dataCriacao);
  }
  if (Array.isArray(payload.checkpoints)) {
    payload.checkpoints.forEach(cp => {
      // Caches gravados antes de 20/08/2026 (P1-28) têm o `RegisteredAt2` em
      // DD/MM/YYYY, formato que `_normTz` ignora de propósito e que o
      // `new Date()` do front lê como M/D — data errada até o dia 12 e
      // Invalid Date do 13 em diante. O VALOR estava certo (é hora local BRT,
      // conferido contra TimeStamp na KB), só o formato não era parseável;
      // então aqui convertemos pra ISO com offset, sem deslocar o instante.
      if (cp) cp.timestamp = _normTz(_brToIso(cp.timestamp));
    });
  }
  return payload;
}

module.exports = { processarNota, classificarSubCategoria, fixCachedPayloadTz };
