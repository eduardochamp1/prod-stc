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
 * @param {object} nota   Payload bruto vindo de getNoteDetail()
 * @param {object} opts   { incluirFotos?: boolean, subcat?: object }
 * @returns {object}      Resposta normalizada para o front
 */
function processarNota(nota, opts = {}) {
  const incluirFotos = !!opts.incluirFotos;
  const subcat       = opts.subcat || { subCategoria: null, subcatCode: null, quantidade: null };

  // Checkpoints ordenados cronologicamente; fotos só vão se solicitado
  const checkpoints = (nota.Checkpoints || [])
    .sort((a, b) => new Date(a.RegisteredAt2 || a.TimeStamp) - new Date(b.RegisteredAt2 || b.TimeStamp))
    .map(cp => {
      const fotos = (cp.FileWrappers || []).map((fw, idx) => ({
        index:    idx,
        base64:   incluirFotos ? fw.Base64 : undefined,
        hasImage: Boolean(fw.Base64),
      }));
      return {
        id:          cp.Id,
        event:       cp.Event,
        timestamp:   cp.RegisteredAt2 || cp.TimeStamp,
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
      emissao:         nota.IssueDate2      || nota.IssueDate,
      desejada:        nota.DesiredConclusionDate2 || nota.DesiredConclusionDate,
      conclusao:       nota.ConclusionDate2 || nota.ConclusionDate,
      statusConclusao: nota.ConclusionStatus,
      importacao:      nota.ImportDate2     || nota.ImportDate,
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
      dataCriacao:      nota.CreationDate2 || nota.CreationDate,
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

module.exports = { processarNota, classificarSubCategoria };
