/**
 * services/dataService.js
 * Abstrai a fonte de dados: mock local (DATA_MODE=mock) ou WPA real (DATA_MODE=wpa).
 */

const { getMockTeams, getMockTeamDetail, getMockSummary } = require('../mock/mockData');
const { getTeamsBySector, REGIONAL_MAP } = require('./wpaService');
const { isOficial, getMeta } = require('./equipesOficiais');

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
    const { getClient } = require('./supabaseClient');
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

  // Determina quais setores buscar
  const regional = filters.regional || 'ALL';
  const setores  = filters.sectorId && filters.sectorId !== 'ALL'
    ? [filters.sectorId]
    : (SETORES[regional] || SETORES.ALL);

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
  return await _enrichConcluidasDeEncerradas(enriched);
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
async function getSummary() {
  if (MODE === 'mock') return getMockSummary();

  const regionais = [
    { regionalId: 'GUA', nome: 'Guarapari', setores: SETORES.GUA },
    { regionalId: 'CAC', nome: 'Cachoeiro',  setores: SETORES.CAC },
  ];

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

module.exports = { getTeams, getTeamDetail, getSummary };
