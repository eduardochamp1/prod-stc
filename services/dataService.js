/**
 * services/dataService.js
 * Abstrai a fonte de dados: mock local (DATA_MODE=mock) ou WPA real (DATA_MODE=wpa).
 */

const { getMockTeams, getMockTeamDetail, getMockSummary } = require('../mock/mockData');
const { getTeamsBySector, isSectorDisabled, REGIONAL_MAP } = require('./wpaService');
const { isOficial, getMeta } = require('./equipesOficiais');
const { classifyBuckets } = require('./bucketMath');   // fonte única da aritmética de buckets (P2-2)
// Nota: regional agora é SEMPRE string[] de siglas reais (GUA/CAC/SJC).
// Caller (route ou cron) responsável por garantir array válido.

const MODE = (process.env.DATA_MODE || 'mock').toLowerCase();

// Limiar pra logar o timing por fase do getTeams. Mesmo default do slow_request.
const GETTEAMS_LOG_MS = Number(process.env.SLOW_REQUEST_MS) || 1500;

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
 * Decide o logon de REFERÊNCIA (o mais antigo do dia) e se houve RELOGIN, com
 * uma guarda de intervalo (gap). FUNÇÃO PURA (testável).
 *
 * observação 29/07/2026: até então QUALQUER diferença entre o primeiro
 * sessionBegin do dia e o atual contava como relogin, sem limite. Se uma equipe
 * logar de novo após um intervalo GRANDE (um turno separado, não uma
 * reconexão), isso poderia (a) inflar o "relogou" e (b) ancorar o logon num
 * horário muito antigo. `RELOGIN_MAX_GAP_HORAS` (env, default 0 = DESLIGADO)
 * define o limite: acima dele, a sessão atual é tratada como NOVA — não é
 * relogin e o logon de referência passa a ser o da própria sessão atual.
 *
 * Default 0 preserva EXATAMENTE o comportamento anterior (nunca caímos na
 * condição de gap grande até hoje — mantido intencionalmente).
 *
 * @param   {string|null} primeiro  sessionBegin do 1º snapshot do dia (ISO)
 * @param   {string|null} atual     sessionBegin da sessão atual (ISO)
 * @param   {number} maxGapHoras    limite em horas; 0/negativo = sem limite
 * @returns {{ sessionBeginReal: string|null, relogouNoDia: boolean }}
 */
function _resolveLogon(primeiro, atual, maxGapHoras = 0) {
  if (!primeiro || !atual || primeiro === atual) {
    return { sessionBeginReal: primeiro || atual || null, relogouNoDia: false };
  }
  const gapH = Math.abs(new Date(atual) - new Date(primeiro)) / 3600000;
  const semLimite = !maxGapHoras || maxGapHoras <= 0;
  const dentroDoLimite = semLimite || (Number.isFinite(gapH) && gapH <= maxGapHoras);
  return dentroDoLimite
    ? { sessionBeginReal: primeiro, relogouNoDia: true }   // reconexão do mesmo turno
    : { sessionBeginReal: atual,    relogouNoDia: false };  // gap grande → sessão nova
}

/**
 * FUNÇÃO PURA (testável): decide se o 1º logon de HOJE é uma RECONEXÃO da última
 * sessão de ONTEM (turno que virou a noite), pra exibir a noite como UM turno
 * (P1-14 Fase 2). Linka quando o gap entre o `end` de ontem e o `begin` de hoje
 * está em [0, gapMin]. Ontem sem `end` (sessão ainda aberta) ou gap fora da
 * janela → não linka (conservador — e a sessão contínua já mostra o begin certo).
 *
 * @param {string|null} primeiroHoje  1º sessionBegin de hoje (ISO)
 * @param {string|null} ontemBegin    begin da última sessão de ontem (ISO)
 * @param {string|null} ontemEnd      end   da última sessão de ontem (ISO)
 * @param {number} gapMin             limite em minutos
 * @returns {{linked:boolean, sessionBeginReal?:string, ontemBegin?:string, ontemEnd?:string}}
 */
function _linkViraNoite(primeiroHoje, ontemBegin, ontemEnd, gapMin) {
  if (!primeiroHoje || !ontemBegin || !ontemEnd) return { linked: false };
  const gap = (new Date(primeiroHoje) - new Date(ontemEnd)) / 60000;
  if (!Number.isFinite(gap) || gap < 0 || gap > gapMin) return { linked: false };
  return { linked: true, sessionBeginReal: ontemBegin, ontemBegin, ontemEnd };
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
      // SELECT ENXUTO: só a coluna session_begin (não o jsonb `data`) — reduz
      // drasticamente o payload desta varredura. Ver nota do incidente abaixo.
      const { data, error } = await sb
        .from('snapshots')
        .select('team_name, session_begin, captured_at')
        .eq('date', hoje)
        .in('team_name', siglas)
        .order('captured_at', { ascending: true })
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error) break;
      if (!data || data.length === 0) break;
      data.forEach(r => {
        if (primeiroSessionBegin[r.team_name]) return; // já temos o primeiro
        if (r.session_begin) primeiroSessionBegin[r.team_name] = r.session_begin;
      });
      if (data.length < 1000) break;
      page++;
    }

    // ÚLTIMA sessão de ONTEM por equipe (mais recente) — pra detectar turno
    // vira-noite (P1-14 Fase 2). Snapshots de ontem DESC → 1º = mais recente.
    const ontem = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
    const ontemUltima = {};
    // ⚠️ SELECT ENXUTO (colunas, NÃO o jsonb `data`) — incidente 30/07/2026: a
    // 1ª versão desta query trazia `data` (o payload inteiro da equipe) de TODOS
    // os snapshots de ontem × 45 equipes = dezenas de MB por request, e o
    // /api/teams passou a demorar/travar o Monitor. As colunas session_begin /
    // session_end da própria tabela têm o que precisamos. NÃO voltar a pedir `data` aqui.
    let pageO = 0;
    while (true) {
      const { data, error } = await sb
        .from('snapshots')
        .select('team_name, session_begin, session_end, captured_at')
        .eq('date', ontem)
        .in('team_name', siglas)
        .order('captured_at', { ascending: false })
        .range(pageO * 1000, (pageO + 1) * 1000 - 1);
      if (error) break;
      if (!data || data.length === 0) break;
      data.forEach(r => {
        if (ontemUltima[r.team_name]) return;           // já temos a mais recente
        if (r.session_begin) ontemUltima[r.team_name] = { begin: r.session_begin, end: r.session_end || null };
      });
      if (data.length < 1000) break;
      pageO++;
    }

    // Guarda de gap (default 0 = desligado → comportamento idêntico ao anterior).
    const maxGap = parseFloat(process.env.RELOGIN_MAX_GAP_HORAS || '0');
    const gapViraNoite = parseInt(process.env.RECONEXAO_MAX_GAP_MIN || '60', 10) || 60;
    teams.forEach(t => {
      const nome = t.teamName || t.sigla;
      const primeiro = primeiroSessionBegin[nome];
      // sessionBeginReal = logon mais antigo do dia; relogouNoDia = reconexão.
      // A regra (com guarda de gap) vive em _resolveLogon — testada isoladamente.
      const r = _resolveLogon(primeiro, t.sessionBegin, maxGap);
      t.sessionBeginReal = r.sessionBeginReal;
      t.relogouNoDia     = r.relogouNoDia;

      // P1-14 Fase 2: se o 1º logon de hoje é reconexão da última sessão de
      // ontem (turno vira-noite), mostra a noite como UM turno — início = o de
      // ontem, e o histórico de conexões lista as duas sessões. Só ativa nesse
      // caso; equipes normais ficam intactas.
      const ont = ontemUltima[nome];
      const link = _linkViraNoite(primeiro || t.sessionBegin, ont && ont.begin, ont && ont.end, gapViraNoite);
      if (link.linked) {
        t.sessionBeginReal = link.sessionBeginReal;     // logon real = 20:05 (ontem)
        t.relogouNoDia     = true;
        t.turnoViraNoite   = true;
        t.sessions = [
          { begin: link.ontemBegin, end: link.ontemEnd },
          { begin: t.sessionBegin,  end: t.sessionEnd || null },
        ];
      }
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
 * Filtragem: `regionals` (string[] de siglas reais, vindo de req.scope.regionals)
 * restringe o cálculo ao escopo do usuário. Sem isso, o summary vazaria
 * contagens de regionais que o user não deveria ver. `null` = sem filtro
 * (uso interno/cron, que não tem escopo de usuário).
 *
 * ⚠️ O ESCOPO VEM DA REGIONAL, NÃO DAS EQUIPES VIVAS (incidente 25/08/2026).
 * Até aqui o filtro era a lista de SIGLAS que a coleta ao vivo tinha acabado de
 * devolver. Quando a coleta de um setor falha, essa lista vem VAZIA — e array
 * vazio fazia a cláusula WHERE sumir da query, devolvendo o banco INTEIRO sob o
 * rótulo da regional escolhida. Em 25/08 a credencial WPA de SJC (contas `sp` e
 * `sp2`) estava inválida, DSSJ falhava em todo ciclo, e o painel filtrado em
 * "São José dos Campos" exibiu 313 executadas / 814 em carteira que eram de
 * GUA+CAC — com ZERO snapshot de SJC no dia. Número de outra regional é pior
 * que número nenhum: vai para relatório da EDP.
 *
 * `snapshots.regional` e `note_rejections.regional` são gravados pelo próprio
 * writer, então o recorte não depende de a coleta ao vivo ter dado certo.
 *
 * Retorna null em caso de erro de DB — frontend cai em cálculo per-team.
 */
async function _buildDiaSummary(regionals) {
  try {
    const { _getPool } = require('./pgShim');
    const pool = _getPool();
    if (!pool) return null;
    const hoje = _hojeBRT();

    // 2 queries em paralelo: primeiro e último snapshot do dia por equipe.
    // DISTINCT ON é eficiente (1 row por equipe) e usa índice de captured_at.
    const filterClause = (Array.isArray(regionals) && regionals.length > 0)
      ? `AND regional = ANY($2::text[])`
      : '';
    const params = [hoje];
    if (filterClause) params.push(regionals);

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

    // 3ª query: note_rejections persistente. WPA limpa notasRejeitadas do
    // payload após algumas horas, então o snapshot subconta. note_rejections
    // é alimentada por cron separado (services/rejectionService.js) via
    // /api/notes/rejected — é a FONTE AUTORITATIVA pra UUIDs rejeitadas no dia.
    const queryRej = `
      SELECT note_id
      FROM note_rejections
      WHERE session_date = $1 ${filterClause}`;

    const [firstRes, lastRes, rejRes] = await Promise.all([
      pool.query(queryFirst, params),
      pool.query(queryLast, params),
      pool.query(queryRej, params),
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

    // União com note_rejections persistente — captura rejeitadas que o WPA
    // já limpou do payload do dispositivo. Sem isso, snapshot.rejeitadas
    // subconta (ex: dia 12/06 mostrava 2 vs 17 reais na tabela).
    for (const r of rejRes.rows) {
      if (r.note_id) rejeitadasRaw.add(r.note_id);
    }

    // Classificação única por UUID — cada nota fica em EXATAMENTE 1 bucket
    // final. Sem isso, a aritmética inflava 'canceladas' (UUIDs em 2 buckets
    // sobrepostos eram contados 2x na soma, mas só 1x na união) — bug
    // reportado em 11/06/2026 (esperado canc=294, retornava 904).
    //
    // Prioridade: rejeitada > concluída > andamento > atual (decisão 20/07/2026,
    // José). Uma nota concluída pela equipe E rejeitada pela EDP conta SÓ como
    // rejeitada — não é produção válida. O WPA mantém a nota nas duas fontes, e
    // sem esta prioridade a produtividade reportada inflava (ECTSJ83: 17
    // executadas sendo 14 rejeitadas). Deve bater com _aggregateTeamDailyTotals
    // e detectDrift em dataWriter.js.
    // A classificação por prioridade (acima) + canceladas/entradas agora vive na
    // FONTE ÚNICA services/bucketMath.classifyBuckets (P2-2) — a mesma que o
    // histórico persistido (dataWriter.upsertTeamDailyCarteira) usa, pra os dois
    // nunca divergirem. Invariante e regra documentadas lá.
    return classifyBuckets({
      inicial:    inicialUUIDs,
      atual:      atualRaw,
      andamento:  andamentoRaw,
      concluidas: concluidasRaw,
      rejeitadas: rejeitadasRaw,
    });
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
    // Uma query só. ⚠️ 21/08/2026: este comentário afirmava que o índice em
    // (date, team_name, captured_at) "torna isso barato" — mas esse índice NÃO
    // EXISTIA. Os reais eram só (captured_at DESC) e (date, team_name), então
    // cada chamada ordenava dentro do grupo, numa tabela retida pra sempre.
    // Criar com scripts/criar-indice-snapshots.js (CONCURRENTLY, sem lock).
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

/**
 * Traduz o report por SETOR (out.report do getTeams) para o estado por REGIONAL
 * que o painel entende. FUNÇÃO PURA — sem I/O, testável.
 *
 * P1-39 (25/08/2026). Motivação: a coleta de SJC morreu em 24/08 (credencial WPA
 * inválida nas duas contas) e o painel exibiu "Nenhuma equipe encontrada" com
 * `0 em campo` — indistinguível de um domingo. O `snapshot_partial` estava certo
 * no log desde o primeiro ciclo; ninguém lê log. Levou ~18h até um gestor
 * perguntar por que SP tinha sumido. `0` e `indisponível` não são a mesma
 * informação, e só quem chamou getTeams sabe a diferença.
 *
 * @param {object} report        { ok:[], failed:[{sector,msg}], skipped:[] }
 * @param {object} sectorLastOk  { DSSJ: '2026-08-24T14:00:00Z', ... } — último
 *                               ciclo em que o setor coletou (app_settings).
 * @param {string[]} regionals   escopo do usuário; sem ele, todas as regionais.
 * @returns {{degradado: boolean, regionais: Object}}
 */
function buildColetaStatus(report, sectorLastOk, regionals) {
  const regs = (Array.isArray(regionals) && regionals.length > 0)
    ? regionals
    : Object.keys(SETORES).filter(k => k !== 'ALL');

  const falhaMsg = new Map();
  for (const f of (report && Array.isArray(report.failed) ? report.failed : [])) {
    if (f && f.sector) falhaMsg.set(f.sector, f.msg || '');
  }
  const pulados = new Set(report && Array.isArray(report.skipped) ? report.skipped : []);
  const lastOk = (sectorLastOk && typeof sectorLastOk === 'object') ? sectorLastOk : {};

  const out = { degradado: false, regionais: {} };
  for (const r of regs) {
    const setores = SETORES[r] || [];
    const comFalha  = setores.filter(s => falhaMsg.has(s));
    const comPulado = setores.filter(s => pulados.has(s));
    const afetados  = [...comFalha, ...comPulado];

    if (afetados.length === 0) {
      out.regionais[r] = { status: 'ok', setores: [], parcial: false, desde: null, msg: null };
      continue;
    }

    // Kill-switch (WPA_ACCOUNTS_DISABLED) é decisão operacional consciente —
    // "pausada" e não "falha". Mas segue degradando: ausência de dado tem de
    // aparecer no painel de qualquer forma, senão o operador esquece que
    // desligou. Falha ganha da pausa quando os dois estados coexistem.
    const status = comFalha.length > 0 ? 'falha' : 'pausada';

    // `desde` = o momento MAIS ANTIGO entre os setores afetados: o que o
    // operador precisa saber é há quanto tempo o buraco existe, não qual setor
    // caiu por último. Sem registro, fica null — nunca inventa horário.
    let desde = null;
    for (const s of afetados) {
      const ts = lastOk[s];
      if (!ts) continue;
      if (desde === null || ts < desde) desde = ts;
    }

    out.regionais[r] = {
      status,
      setores: afetados,
      parcial: afetados.length < setores.length,   // sobrou setor coletando?
      desde,
      msg: comFalha.length > 0 ? (falhaMsg.get(comFalha[0]) || null) : null,
    };
    out.degradado = true;
  }
  return out;
}

// Resultado por setor da ÚLTIMA chamada de getTeams (P1-3+): { ok:[], failed:[],
// skipped:[] }. O runSnapshot lê pra marcar snapshot_last_ok/snapshot_error com
// ciência de qual conta está fora — sem isso, uma conta desativada/quebrada
// travava o marcador de saúde do ciclo inteiro.
// ⚠️ Estado de MÓDULO: só sirva de retrocompat. Para saber o resultado da SUA
// chamada, passe `out` em getTeams(filters, out) e leia `out.report` (P1-30).
let _lastSectorReport = { ok: [], failed: [], skipped: [] };
function getLastSectorReport() { return _lastSectorReport; }

// ── GET TEAMS ─────────────────────────────────────────────────────────────────
// @param {object} [out] recebe `out.report = {ok, failed, skipped}` desta chamada.
async function getTeams(filters = {}, out = null) {
  if (MODE === 'mock') return getMockTeams(filters);
  const t0 = Date.now();

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
  //
  // ⚠️ RESILIÊNCIA POR SETOR (13/08/2026): um setor que falha (breaker/rede/WPA,
  // ou conta desativada) NÃO derruba os outros. Antes, o loop lançava no 1º erro
  // e um snapshot ATÉ de GUA/CAC era perdido quando só a conta SP estava fora —
  // o snapshot ficava tudo-ou-nada entre contas. Agora coleta o que der e expõe
  // o resultado por setor em getLastSectorReport(), que o runSnapshot usa pra
  // decidir sucesso × erro do ciclo (e não travar o snapshot_last_ok à toa).
  const report = { ok: [], failed: [], skipped: [] };
  const resultados = [];
  for (const s of setores) {
    if (isSectorDisabled(s)) { report.skipped.push(s); continue; }
    try {
      resultados.push(await getTeamsBySector(s));
      report.ok.push(s);
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 140);
      report.failed.push({ sector: s, msg });
      console.warn(`[dataService] setor ${s} falhou (${msg.slice(0, 90)}) — seguindo com os demais.`);
    }
  }
  // 20/08/2026 (backlog P1-30): o report SÓ vivia no global `_lastSectorReport`,
  // e entre esta atribuição e a leitura pelo runSnapshot há TRÊS await com I/O
  // de banco (os enriches abaixo). Um `/api/teams` de browser chegando nessa
  // janela sobrescrevia o global com o report DELE — escopo GUA, failed: [] —
  // e o snapshot gravava `sectors_failed: []` com SJC ausente da coleta:
  // saúde verde e produção faltando, anulando o P1-21. Agora quem chama recebe
  // o report DAQUELA chamada via `out`; o global fica só como retrocompat.
  if (out && typeof out === 'object') out.report = report;
  _lastSectorReport = report;
  const teams = _filterOficiais(resultados.flat());
  const tColeta = Date.now();

  // Enriquecer com escala (de equipes_oficiais) e sessionBeginReal (primeiro snapshot do dia)
  const enriched = await _enrichComEscalaELogonReal(teams);
  const tEsc = Date.now();
  // Restaurar notasConcluidas de equipes encerradas (EDP não expõe pós-deslog)
  const comConcluidas = await _enrichConcluidasDeEncerradas(enriched);
  const tConc = Date.now();
  // Carteira Inicial REAL do primeiro snapshot do dia (cada equipe individualmente)
  const final = await _enrichCarteiraInicial(comConcluidas);
  const tCart = Date.now();

  // TIMING POR FASE (21/08/2026). O slow_request mostrou /api/teams em 17s na
  // primeira chamada e ~2s nas seguintes, mas o total não diz ONDE o tempo vai:
  // a coleta serial na EDP e os três enriquecimentos (que varrem snapshots
  // paginados) são candidatos bem diferentes, e cada um pede conserto diferente.
  // Só loga acima do limiar pra não poluir. Mesmo limiar do slow_request.
  const total = tCart - t0;
  if (total >= GETTEAMS_LOG_MS) {
    console.log('[getTeams] ' + JSON.stringify({
      total_ms:    total,
      coleta_ms:   tColeta - t0,     // fetches na EDP, serial por setor
      escala_ms:   tEsc - tColeta,   // _enrichComEscalaELogonReal (snapshots hoje+ontem)
      encerradas_ms: tConc - tEsc,   // _enrichConcluidasDeEncerradas
      carteira_ms: tCart - tConc,    // _enrichCarteiraInicial
      setores:     report.ok.length,
      equipes:     final.length,
    }));
  }
  return final;
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
      // Concluídas rejeitadas pela EDP não contam como produção (rejeitada >
      // concluída, decisão 20/07/2026 — ver _aggregateTeamDailyTotals).
      totalConcluidas: teams.reduce((s, t) => {
        const rej = new Set((t.notasRejeitadas || []).map(n => n && n.id).filter(Boolean));
        return s + (t.notasConcluidas || []).filter(n => !(n && n.id && rej.has(n.id))).length;
      }, 0),
      totalRejeitadas: teams.reduce((s, t) => s + (t.notasRejeitadas || []).length, 0),
    };
  }));
}

module.exports = { getTeams, getLastSectorReport, getTeamDetail, getSummary, _carteiraInicialDedupTotal, _buildDiaSummary, _resolveLogon, _linkViraNoite, buildColetaStatus };
