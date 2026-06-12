/**
 * services/dataService.js
 * Abstrai a fonte de dados: mock local (DATA_MODE=mock) ou WPA real (DATA_MODE=wpa).
 */

const { getMockTeams, getMockTeamDetail, getMockSummary } = require('../mock/mockData');
const { getTeamsBySector, REGIONAL_MAP } = require('./wpaService');
const { isOficial, getMeta } = require('./equipesOficiais');
// Nota: regional agora é SEMPRE string[] de siglas reais (GUA/CAC/SJC).
// Caller (route ou cron) responsável por garantir array válido.

const MODE = (process.env.DATA_MODE || 'mock').toLowerCase();

// Filtra um array de teams mantendo apenas equipes oficiais (whitelist).
// Em modo "mock" não aplica filtro (mantém comportamento de teste).
function _filterOficiais(teams) {
  if (MODE === 'mock') return teams;
  return (teams || []).filter(t => isOficial(t.sigla || t.teamName));
}

// Data BRT no formato YYYY-MM-DD (mesma lógica usada em outros lugares).
function _hojeBRT() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Enriquecer teams com:
 *   - escala_inicio / escala_fim (turno configurado em equipes_oficiais)
 *   - sessionBeginReal: sessionBegin do PRIMEIRO snapshot do dia (não o atual).
 *     Sem isso, equipes que relogaram aparecem como se tivessem começado tarde.
 *
 * Falha silenciosa: se o Supabase estiver fora ou ainda não tiver snapshots de hoje,
 * apenas mantém os valores do WPA.
 */
async function _enrichComEscalaELogonReal(teams) {
  if (!teams || teams.length === 0) return teams;

  // 1) Escala vem do cache local (equipesOficiais)
  teams.forEach(t => {
    const meta = getMeta(t.sigla || t.teamName);
    if (meta) {
      t.escala_inicio = meta.escala_inicio || null;
      t.escala_fim    = meta.escala_fim    || null;
    }
  });

  // 2) sessionBeginReal: primeiro snapshot do dia (BRT) de cada equipe
  try {
    const { getClient } = require('./dbClient');
    const sb = getClient();
    if (!sb) return teams;
    const hoje = _hojeBRT();
    const siglas = teams.map(t => t.teamName || t.sigla).filter(Boolean);
    if (siglas.length === 0) return teams;

    // Pega TODOS os snapshots de hoje das equipes ativas (paginado, ordenado por captured_at ASC).
    // Pra cada equipe, o PRIMEIRO snapshot vai ter o sessionBegin original do dia.
    const primeiroSessionBegin = {};
    let page = 0;
    while (true) {
      const { data, error } = await sb
        .from('snapshots')
        .select('team_name, data, captured_at')
        .eq('date', hoje)
        .in('team_name', siglas)
        .order('captured_at', { ascending: true })
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error) break;
      if (!data || data.length === 0) break;
      data.forEach(r => {
        if (primeiroSessionBegin[r.team_name]) return; // já temos o primeiro
        const sb1 = r.data?.sessionBegin || r.data?.session_begin || null;
        if (sb1) primeiroSessionBegin[r.team_name] = sb1;
      });
      if (data.length < 1000) break;
      page++;
    }

    teams.forEach(t => {
      const nome = t.teamName || t.sigla;
      const primeiro = primeiroSessionBegin[nome];
      // Se há um primeiro snapshot e seu sessionBegin é DIFERENTE do atual,
      // a equipe relogou. Salva o primeiro como sessionBeginReal e marca o flag.
      t.sessionBeginReal = primeiro || t.sessionBegin || null;
      t.relogouNoDia     = !!(primeiro && t.sessionBegin && primeiro !== t.sessionBegin);
    });
  } catch (err) {
    console.warn('[dataService] enrich logon real falhou:', err.message);
  }

  return teams;
}

/**
 * Carteira Inicial REAL de cada equipe: total de notas que a equipe tinha
 * quando iniciou a escala do dia. Lida do PRIMEIRO snapshot do dia de cada
 * equipe (cron grava a cada ~5 min). Conceito definido pelo usuário em
 * 08/06/2026: "total que a equipe iniciou a escala" — vai diminuindo ao
 * longo do dia conforme notas são concluídas, rejeitadas, ou transferidas.
 *
 * Decisões (confirmadas com usuário):
 *  - Equipe que relogou no dia: usa a PRIMEIRA sessão (primeiro snapshot).
 *  - Equipe que ainda não logou: ignora (carteiraInicialReal = null).
 *
 * Implementação: SQL DISTINCT ON com ORDER BY captured_at ASC → primeiro
 * snapshot. Soma length dos 4 buckets do snapshot. Não filtra por estado
 * porque no primeiro snapshot concluídas/rejeitadas costumam estar zeradas
 * (equipe acabou de logar) e o resultado se reduz a baixadas+andamento ≈
 * carteira inicial real.
 */
async function _enrichCarteiraInicial(teams) {
  if (!teams || teams.length === 0) return teams;

  try {
    const { _getPool } = require('./pgShim');
    const pool = _getPool();
    if (!pool) return teams;
    const hoje = _hojeBRT();
    const siglas = teams.map(t => t.teamName || t.sigla).filter(Boolean);
    if (siglas.length === 0) return teams;

    // Antes pegávamos só os comprimentos (jsonb_array_length). Agora extraímos
    // os ARRAYS completos pra deduplicar UUIDs entre equipes: o EDP redistribui
    // notas durante o dia, e a mesma nota pode aparecer no primeiro snapshot de
    // 2 equipes diferentes (uma onde estava, outra pra onde foi). Sem dedup,
    // a soma global das carteiras iniciais inflava artificialmente (446 OS
    // "fantasma" reportadas em 11/06/2026, admin via 3438 inicial / 2992
    // explicáveis em saídas).
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (team_name)
              team_name,
              coalesce(data->'notasBaixadas',   '[]'::jsonb) AS baixadas,
              coalesce(data->'notasExecutadas', '[]'::jsonb) AS executadas,
              coalesce(data->'notasConcluidas', '[]'::jsonb) AS concluidas,
              coalesce(data->'notasRejeitadas', '[]'::jsonb) AS rejeitadas
       FROM snapshots
       WHERE date = $1
         AND team_name = ANY($2::text[])
       ORDER BY team_name, captured_at ASC`,
      [hoje, siglas]
    );

    // Para cada equipe: extrai UUIDs únicos dos 4 buckets do primeiro snapshot.
    // count individual = uuids únicos DENTRO da equipe (raro ter dup intra-team).
    const dataPorEquipe = {};
    rows.forEach(r => {
      const uuids = new Set();
      ['baixadas', 'executadas', 'concluidas', 'rejeitadas'].forEach(bucket => {
        const arr = r[bucket] || [];
        if (Array.isArray(arr)) {
          arr.forEach(n => { if (n && n.id) uuids.add(n.id); });
        }
      });
      dataPorEquipe[r.team_name] = {
        count: uuids.size,
        uuids: [...uuids],
      };
    });

    let comDados = 0;
    teams.forEach(t => {
      const nome = t.teamName || t.sigla;
      const info = dataPorEquipe[nome];
      if (info) {
        t.carteiraInicialReal = info.count;
        // Anexa UUIDs ao team pra que a camada acima (getTeams) possa agregar
        // globalmente deduplicado. Frontend NUNCA deve usar t._carteiraInicialUUIDs
        // diretamente — só o `summary.carteira_inicial_dedup` do response.
        t._carteiraInicialUUIDs = info.uuids;
        comDados++;
      } else {
        t.carteiraInicialReal = null;
        t._carteiraInicialUUIDs = null;
      }
    });
    console.log(`[dataService] carteira inicial: ${comDados}/${teams.length} equipes com primeiro snapshot do dia`);
  } catch (err) {
    console.warn('[dataService] enrich carteira inicial falhou:', err.message);
  }

  return teams;
}

/**
 * Soma global deduplicada dos UUIDs do primeiro snapshot do dia de TODAS as
 * equipes — resolve dupla contagem de notas transferidas entre equipes pelo
 * EDP. Retorna número (count) ou null se nenhuma equipe tinha UUIDs.
 *
 * Espera que `_enrichCarteiraInicial` já tenha rodado e populado
 * `t._carteiraInicialUUIDs` em cada team.
 */
function _carteiraInicialDedupTotal(teams) {
  if (!Array.isArray(teams) || teams.length === 0) return null;
  const seen = new Set();
  let hadAny = false;
  for (const t of teams) {
    const uuids = t._carteiraInicialUUIDs;
    if (!Array.isArray(uuids)) continue;
    hadAny = true;
    for (const u of uuids) seen.add(u);
  }
  return hadAny ? seen.size : null;
}

/**
 * Build do summary completo do dia comparando PRIMEIRO e ÚLTIMO snapshot
 * de cada equipe. Detecta:
 *
 *   inicial    = UUIDs únicos no PRIMEIRO snap (qualquer bucket)
 *   atual      = UUIDs em "baixadas" do ÚLTIMO snap (pendentes não iniciadas)
 *   andamento  = UUIDs em "executadas" do ÚLTIMO snap (em execução)
 *   concluidas = UUIDs em "concluidas" do ÚLTIMO snap
 *   rejeitadas = UUIDs em "rejeitadas" do ÚLTIMO snap
 *   canceladas = inicial \ (atual ∪ andamento ∪ concluidas ∪ rejeitadas)
 *                ← notas que estavam no payload no início do dia mas SUMIRAM
 *                  (canceladas/transferidas pelo EDP sem virar concluída/rejeitada).
 *
 * Aritmética: inicial = atual + andamento + concluidas + rejeitadas + canceladas.
 *
 * Filtragem: `siglasFiltro` (opcional) restringe o cálculo às equipes do escopo
 * do usuário (admin → todas; non-admin → só suas regionais). Sem isso, o summary
 * vazaria contagens de regionais que o user não deveria ver.
 *
 * Retorna null em caso de erro de DB — frontend cai em cálculo per-team.
 */
async function _buildDiaSummary(siglasFiltro) {
  try {
    const { _getPool } = require('./pgShim');
    const pool = _getPool();
    if (!pool) return null;
    const hoje = _hojeBRT();

    // 2 queries em paralelo: primeiro e último snapshot do dia por equipe.
    // DISTINCT ON é eficiente (1 row por equipe) e usa índice de captured_at.
    const filterClause = (Array.isArray(siglasFiltro) && siglasFiltro.length > 0)
      ? `AND team_name = ANY($2::text[])`
      : '';
    const params = [hoje];
    if (filterClause) params.push(siglasFiltro);

    const queryFirst = `
      SELECT DISTINCT ON (team_name) team_name,
        coalesce(data->'notasBaixadas',   '[]'::jsonb) AS baixadas,
        coalesce(data->'notasExecutadas', '[]'::jsonb) AS executadas,
        coalesce(data->'notasConcluidas', '[]'::jsonb) AS concluidas,
        coalesce(data->'notasRejeitadas', '[]'::jsonb) AS rejeitadas
      FROM snapshots
      WHERE date = $1 ${filterClause}
      ORDER BY team_name, captured_at ASC`;

    const queryLast = `
      SELECT DISTINCT ON (team_name) team_name,
        coalesce(data->'notasBaixadas',   '[]'::jsonb) AS baixadas,
        coalesce(data->'notasExecutadas', '[]'::jsonb) AS executadas,
        coalesce(data->'notasConcluidas', '[]'::jsonb) AS concluidas,
        coalesce(data->'notasRejeitadas', '[]'::jsonb) AS rejeitadas
      FROM snapshots
      WHERE date = $1 ${filterClause}
      ORDER BY team_name, captured_at DESC`;

    const [firstRes, lastRes] = await Promise.all([
      pool.query(queryFirst, params),
      pool.query(queryLast, params),
    ]);

    const inicialUUIDs   = new Set();
    const atualRaw       = new Set();
    const andamentoRaw   = new Set();
    const concluidasRaw  = new Set();
    const rejeitadasRaw  = new Set();

    // Primeiro snap → INICIAL (todos os buckets juntos, dedup global)
    for (const r of firstRes.rows) {
      ['baixadas', 'executadas', 'concluidas', 'rejeitadas'].forEach(b => {
        const arr = r[b];
        if (Array.isArray(arr)) {
          for (const n of arr) { if (n && n.id) inicialUUIDs.add(n.id); }
        }
      });
    }

    // Último snap → estados ATUAIS por bucket (com possíveis sobreposições
    // entre equipes — mesma nota pode estar em "concluida" na equipe A e
    // "baixada" na equipe B se EDP transferiu pós-conclusão; ou em equipes
    // USO MÚTUO que compartilham notas).
    for (const r of lastRes.rows) {
      const addAll = (arr, set) => {
        if (Array.isArray(arr)) for (const n of arr) { if (n && n.id) set.add(n.id); }
      };
      addAll(r.baixadas,   atualRaw);
      addAll(r.executadas, andamentoRaw);
      addAll(r.concluidas, concluidasRaw);
      addAll(r.rejeitadas, rejeitadasRaw);
    }

    // Classificação única por UUID — cada nota fica em EXATAMENTE 1 bucket
    // final. Prioridade: concluida > rejeitada > andamento > atual.
    // Sem isso, a aritmética inflava 'canceladas' (UUIDs em 2 buckets
    // sobrepostos eram contados 2x na soma, mas só 1x na união) — bug
    // reportado em 11/06/2026 (esperado canc=294, retornava 904).
    const finalAtual      = new Set();
    const finalAndamento  = new Set();
    const finalConcluidas = new Set();
    const finalRejeitadas = new Set();
    const todasRastreadas = new Set([
      ...atualRaw, ...andamentoRaw, ...concluidasRaw, ...rejeitadasRaw,
    ]);
    for (const u of todasRastreadas) {
      if      (concluidasRaw.has(u))  finalConcluidas.add(u);
      else if (rejeitadasRaw.has(u))  finalRejeitadas.add(u);
      else if (andamentoRaw.has(u))   finalAndamento.add(u);
      else                            finalAtual.add(u);
    }

    // Canceladas = inicial \ (todos os buckets do último snap).
    // Notas que estavam no início mas sumiram (canceladas pelo EDP).
    let canceladas = 0;
    for (const u of inicialUUIDs) {
      if (!todasRastreadas.has(u)) canceladas++;
    }

    // Invariante (verificável): inicial = atual + andamento + concluidas
    //                                   + rejeitadas + canceladas + entradas_novas
    // onde "entradas_novas" = UUIDs no último snap mas NÃO no primeiro snap
    // (notas que entraram durante o dia, ex: equipe logou tarde com novas
    // notas, ou EDP adicionou ao longo do dia).
    let entradasNovas = 0;
    for (const u of todasRastreadas) {
      if (!inicialUUIDs.has(u)) entradasNovas++;
    }

    return {
      inicial:    inicialUUIDs.size,
      atual:      finalAtual.size,
      andamento:  finalAndamento.size,
      concluidas: finalConcluidas.size,
      rejeitadas: finalRejeitadas.size,
      canceladas,
      entradas_novas: entradasNovas,
    };
  } catch (err) {
    console.warn('[dataService] buildDiaSummary falhou:', err.message);
    return null;
  }
}

/**
 * Enriquece equipes ENCERRADAS (sessionEnd preenchido) cujo notasConcluidas
 * está vazio. Causa: v2.Concluded só popula sessões abertas, e a EDP não
 * expõe endpoint /api/notes/concluded/{sessionId}/session (confirmado 404
 * em probe 08/06/2026). Solução: recuperar do último snapshot do dia que
 * tinha notasConcluidas populado — capturado pelo cron enquanto sessão
 * estava aberta.
 *
 * Sem isso, ~110 de 128 equipes (que já deslogaram às 17h) aparecem com
 * conc=0, e o KPI "OS Executadas" do Monitor mostra valor muito abaixo
 * do real à noite.
 *
 * Usa SQL DISTINCT ON pra pegar de uma vez o último snapshot por equipe
 * que tinha concluídas — versão paginada anterior pegava só os 1000
 * snapshots mais recentes do dia, deixando equipes sem snapshot recente
 * com versão antiga/vazia (sintoma: em modo ALL, 119 equipes × 12 snaps
 * estouravam 1000, ~30 equipes ficavam com dados incompletos).
 */
async function _enrichConcluidasDeEncerradas(teams) {
  if (!teams || teams.length === 0) return teams;

  const candidatos = teams.filter(t =>
    t.sessionEnd &&                                  // sessão encerrada
    (t.notasConcluidas || []).length === 0           // sem dados de concluídas
  );
  if (candidatos.length === 0) return teams;

  try {
    const { _getPool } = require('./pgShim');
    const pool = _getPool();
    if (!pool) return teams;
    const hoje = _hojeBRT();
    const siglas = candidatos.map(t => t.teamName || t.sigla).filter(Boolean);
    if (siglas.length === 0) return teams;

    // DISTINCT ON (team_name) com ORDER BY team_name, captured_at DESC
    // → pra cada equipe, o LINHA do snapshot MAIS RECENTE que tinha concluídas.
    // Uma query só, índice em (date, team_name, captured_at) torna isso barato.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (team_name)
              team_name,
              data->'notasConcluidas' AS conc
       FROM snapshots
       WHERE date = $1
         AND team_name = ANY($2::text[])
         AND jsonb_typeof(data->'notasConcluidas') = 'array'
         AND jsonb_array_length(data->'notasConcluidas') > 0
       ORDER BY team_name, captured_at DESC`,
      [hoje, siglas]
    );

    const concPorEquipe = {};
    rows.forEach(r => {
      if (Array.isArray(r.conc) && r.conc.length > 0) {
        concPorEquipe[r.team_name] = r.conc;
      }
    });

    let restauradas = 0;
    let totalNotas = 0;
    candidatos.forEach(t => {
      const nome = t.teamName || t.sigla;
      const conc = concPorEquipe[nome];
      if (conc && conc.length > 0) {
        t.notasConcluidas = conc;
        restauradas++;
        totalNotas += conc.length;
      }
    });
    if (restauradas > 0) {
      console.log(`[dataService] enrich concluídas: ${restauradas}/${candidatos.length} equipes restauradas (${totalNotas} notas) via snapshot`);
    }
  } catch (err) {
    console.warn('[dataService] enrich concluídas encerradas falhou:', err.message);
  }

  return teams;
}

// ── SETORES POR REGIONAL ──────────────────────────────────────────────────────
// SJC adicionado em 08/06/2026 (DSSJ = CSD São José dos Campos / EDP SP).
// O wpaService.wpaFetch roteia automaticamente DSSJ → conta WPA 'sp' via
// SECTOR_TO_ACCOUNT — não precisa de tratamento especial aqui.
const SETORES = {
  GUA: ['DESG', 'DEPT'],
  CAC: ['DESC'],
  SJC: ['DSSJ'],
  ALL: ['DESG', 'DEPT', 'DESC', 'DSSJ'],
};

// ── GET TEAMS ─────────────────────────────────────────────────────────────────
async function getTeams(filters = {}) {
  if (MODE === 'mock') return getMockTeams(filters);

  // Determina quais setores buscar. `filters.regionals` é string[] de siglas
  // reais (GUA/CAC/SJC), expandido pelo middleware applyScope a partir do
  // escopo do usuário. Sem array (ex: cron sem filtro) → SETORES.ALL.
  const regs = Array.isArray(filters.regionals) ? filters.regionals : null;
  let setoresPorRegional;
  if (!regs || regs.length === 0) {
    setoresPorRegional = SETORES.ALL;
  } else {
    setoresPorRegional = regs.flatMap(r => SETORES[r] || []);
    if (setoresPorRegional.length === 0) setoresPorRegional = SETORES.ALL;
  }
  const setores = filters.sectorId && filters.sectorId !== 'ALL'
    ? [filters.sectorId]
    : setoresPorRegional;

  // Busca SERIAL (não paralelo): cada getTeamsBySector já dispara ~60 fetches
  // aninhados (sessões × endpoints rejected/executed). Com 4 setores em paralelo
  // chegava-se a ~240 fetches simultâneos contra a EDP — saturando o pool de
  // conexões HTTP do node (undici default ~6/origin) e o rate limit da EDP.
  // Sintoma: notas vinham vazias intermitentemente em modo ALL (_safeNotes
  // engolia timeouts com catch silencioso). Serial: ~3-5s mais lento, mas
  // resultados consistentes. Vide investigação 08/06/2026.
  const resultados = [];
  for (const s of setores) {
    resultados.push(await getTeamsBySector(s));
  }
  const teams = _filterOficiais(resultados.flat());

  // Enriquecer com escala (de equipes_oficiais) e sessionBeginReal (primeiro snapshot do dia)
  const enriched = await _enrichComEscalaELogonReal(teams);
  // Restaurar notasConcluidas de equipes encerradas (EDP não expõe pós-deslog)
  const comConcluidas = await _enrichConcluidasDeEncerradas(enriched);
  // Carteira Inicial REAL do primeiro snapshot do dia (cada equipe individualmente)
  return await _enrichCarteiraInicial(comConcluidas);
}

// ── GET TEAM DETAIL ───────────────────────────────────────────────────────────
async function getTeamDetail(teamId) {
  if (MODE === 'mock') return getMockTeamDetail(teamId);

  // Busca em todos os setores até achar
  for (const setor of SETORES.ALL) {
    const teams = _filterOficiais(await getTeamsBySector(setor));
    const found = teams.find(t => t.id === teamId || t.sigla === teamId || t.teamName === teamId);
    if (found) return found;
  }
  return null;
}

// ── GET SUMMARY ───────────────────────────────────────────────────────────────
async function getSummary(filters = {}) {
  if (MODE === 'mock') return getMockSummary();

  const TODAS_REGIONAIS = [
    { regionalId: 'GUA', nome: 'Guarapari',           setores: SETORES.GUA },
    { regionalId: 'CAC', nome: 'Cachoeiro',           setores: SETORES.CAC },
    { regionalId: 'SJC', nome: 'São José dos Campos', setores: SETORES.SJC },
  ];

  // Filtra pelas regionais visíveis ao usuário. `filters.regionals` é
  // string[] de siglas reais (sem ALL/grupos). Sem array → todas.
  const regs = Array.isArray(filters.regionals) ? filters.regionals : null;
  const regionais = (regs && regs.length > 0)
    ? TODAS_REGIONAIS.filter(r => regs.includes(r.regionalId))
    : TODAS_REGIONAIS;

  return Promise.all(regionais.map(async r => {
    const resultados = await Promise.all(r.setores.map(s => getTeamsBySector(s)));
    const teams = _filterOficiais(resultados.flat());
    return {
      regionalId:      r.regionalId,
      nome:            r.nome,
      totalEquipes:    teams.length,
      equipesAtivas:   teams.filter(t => !t.sessionEnd).length,
      totalBaixadas:   teams.reduce((s, t) => s + (t.notasBaixadas   || []).length, 0),
      totalExecutadas: teams.reduce((s, t) => s + (t.notasExecutadas || []).length, 0),
      totalConcluidas: teams.reduce((s, t) => s + (t.notasConcluidas || []).length, 0),
      totalRejeitadas: teams.reduce((s, t) => s + (t.notasRejeitadas || []).length, 0),
    };
  }));
}

module.exports = { getTeams, getTeamDetail, getSummary, _carteiraInicialDedupTotal, _buildDiaSummary };
