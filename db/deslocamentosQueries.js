/**
 * db/deslocamentosQueries.js
 *
 * Análise dos deslocamentos das equipes a partir dos checkpoints
 * (`note_details.payload.checkpoints[]`).
 *
 * MAPEAMENTO DOS EVENTOS (descoberto via SQL):
 *   event 0 → Início do Deslocamento  (saída)
 *   event 1 → Fim do Deslocamento     (chegada)
 *   event 2 → Início do Trabalho
 *   event 3 → Fim do Trabalho
 *   event 4 → Interrupção/pausa
 *
 * MÚLTIPLAS TENTATIVAS:
 *   Uma mesma nota pode ter 1, 2 ou 3 deslocamentos (cada tentativa de
 *   execução tem seu par 0→1). Detectamos pelas SEQUÊNCIAS na timeline:
 *   cada vez que aparece event=0, começa uma nova tentativa.
 *
 * REGRA DE NEGÓCIO (definida pelo cliente):
 *   - tempo_real = t(event=1) - t(event=0) por tentativa
 *   - tempo_osrm = duration estimado pelo OSRM (rota dirigindo)
 *   - desvio_pct = ((tempo_real - tempo_osrm) / tempo_osrm) * 100
 *   - threshold = 1.5x (>= 150% do OSRM → vermelho)
 *
 * IMPORTANTE: o "dia" do deslocamento usa o timestamp do event=0
 * (não a sessionDate da nota), porque tentativas podem cruzar dias.
 */

const { _getPool } = require('../services/pgShim');
const { getClient } = require('../services/dbClient');
const { getRoute }  = require('../services/osrmService');
const { inRegionalsSql } = require('../services/regionals');

// Usa a coluna indexada `note_details.first_cp_at` em vez da expressão jsonb.
// Só ligue DEPOIS de scripts/migrar-first-cp-at.js reportar "TEM checkpoint mas
// sem valor: 0" — antes disso a coluna esconderia notas ainda não preenchidas.
const USE_FIRST_CP = process.env.DESLOC_USE_FIRST_CP === '1';

// Teto de notas lidas num período. É válvula de segurança contra OOM (a VM tem
// 3,8GB e o PM2 reinicia em 1G), NÃO uma decisão de produto — por isso é folgado
// e por isso, quando é atingido, a resposta carrega `truncado: true` e a tela
// avisa. O valor antigo era 20000 embutido na query, e em 28/08/2026 ele estava
// sendo atingido no uso normal (24.610 notas em 01/08→27/08) descartando os dias
// mais antigos sem nenhum sinal. Truncar caladamente é o modo de falha que este
// arquivo não pode ter: o número vai pra gestão e pode ser questionado em
// auditoria de contrato.
const MAX_NOTAS_PERIODO = 60000;

// ── helper: extrai deslocamentos de um payload.checkpoints[] ─────────────────

/**
 * Dado o array de checkpoints de UMA nota, retorna lista de deslocamentos:
 *   [{ tentativa: 1, origem: {lat,lng,ts}, destino: {lat,lng,ts}, tempo_real_sec }, ...]
 *
 * Algoritmo:
 *   Itera em ordem cronológica. Cada event=0 começa uma tentativa.
 *   O próximo event=1 da MESMA tentativa fecha o par.
 *   Se aparecer outro event=0 antes do event=1, descarta o anterior
 *   (raro — equipe cancelou e recomeçou).
 */
function extrairDeslocamentos(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return [];

  // Ordena por timestamp (defensivo — geralmente já vem ordenado)
  const ordered = [...checkpoints].sort((a, b) =>
    String(a.timestamp || '').localeCompare(String(b.timestamp || ''))
  );

  const out = [];
  let aberto = null;
  let tentativaCount = 0;

  for (const cp of ordered) {
    if (cp.event === 0) {
      // Novo início — se tinha um anterior pendente, descarta
      aberto = {
        origem: { lat: cp.latitude, lng: cp.longitude, ts: cp.timestamp },
      };
    } else if (cp.event === 1 && aberto) {
      // Fechamento — par válido
      tentativaCount++;
      const oTs = new Date(aberto.origem.ts);
      const dTs = new Date(cp.timestamp);
      const tempo_real_sec = Math.max(0, Math.round((dTs - oTs) / 1000));
      out.push({
        tentativa:      tentativaCount,
        origem:         aberto.origem,
        destino:        { lat: cp.latitude, lng: cp.longitude, ts: cp.timestamp },
        tempo_real_sec,
      });
      aberto = null;
    }
    // events 2, 3, 4 ignorados (não fazem parte do deslocamento)
  }
  return out;
}

// ── Leitura agregada ─────────────────────────────────────────────────────────

/**
 * Lista todos os deslocamentos de notas no período/filtros.
 * Para cada par origem→destino, anexa estimativa OSRM (cache-aware).
 *
 * @param {string} de       'YYYY-MM-DD'
 * @param {string} ate      'YYYY-MM-DD'
 * @param {object} opts     { regional, team_name, tipo, limit }
 * @returns {Promise<Array>} cada item:
 *   { note_id, numero, tipo, team_name, regional, tentativa, origem, destino,
 *     tempo_real_sec, tempo_osrm_sec, distancia_m, desvio_pct, status }
 *   status ∈ 'ok' | 'lento' (> 1.5x) | 'sem_osrm' (consulta falhou)
 */
// Threshold (fator multiplicador) acima do qual um deslocamento é "lento".
// Configurável via app_settings 'desloc-threshold' = { fator: 1.5 }.
// Default 1.5 (real > 1.5× tempo Maps → vermelho). Cache leve de 60s.
const _thrCache = { fator: null, ts: 0 };
async function getThreshold() {
  if (_thrCache.fator !== null && (Date.now() - _thrCache.ts) < 60000) {
    return _thrCache.fator;
  }
  let fator = 1.5;
  try {
    const sb = getClient();
    const { data } = await sb.from('app_settings')
      .select('data').eq('key', 'desloc-threshold').maybeSingle();
    const f = data && data.data && Number(data.data.fator);
    if (f && isFinite(f) && f > 1) fator = f;
  } catch (_) { /* usa default */ }
  _thrCache.fator = fator;
  _thrCache.ts = Date.now();
  return fator;
}

/** Atualiza o cache na hora (chamado após PUT) pra refletir imediato. */
function setThresholdCache(fator) {
  const f = Number(fator);
  if (f && isFinite(f) && f > 1) {
    _thrCache.fator = f;
    _thrCache.ts = Date.now();
  }
}

// 21/08/2026 — aba Deslocamento "sempre demora muito" (reportado pelo usuario).
// O front dispara /lista, /ranking e /tendencia em PARALELO com os mesmos filtros
// (public/index.html ~2726), e rankingEquipes/tendenciaDiaria chamavam a versao
// CRUA de listDeslocamentos. Resultado: o pipeline caro rodava TRES vezes
// concorrentes — 3 varreduras completas de note_details com detoast de jsonb,
// 3 explosoes de snapshots, e ate 3 x 20.000 consultas OSRM.
//
// O cache do fim do arquivo NAO cobria isso, apesar de o comentario dele dizer
// que cobria: as chaves sao por funcao (list/rank/tend), entao as tres chamadas
// nunca colidiam e o single-flight nunca era acionado.
//
// Conserto: as duas derivadas passam a chamar a versao CACHEADA da lista, via
// esta referencia tardia (a cacheada so existe no fim do arquivo). Assim as tres
// requisicoes compartilham UM calculo pelo single-flight do memoCache.
let _listCached = null;

// ── Mapa note_id → equipe, montado por DIA e cacheado por dia ────────────────
//
// 28/08/2026 — o passo 2 era UMA consulta cobrindo o período inteiro: 21,1s
// medidos em produção (01/08→27/08), 70% do tempo restante da aba. O custo é a
// expansão de `jsonb_array_elements` sobre ~170 mil linhas de `snapshots` — com
// captura a cada 15min e retenção ilimitada, o período tem muita linha e cada uma
// detoasta a coluna `data` inteira.
//
// O filtro por note_id NÃO evita isso: `nota_item->>'id' = ANY(...)` só pode ser
// avaliado DEPOIS da expansão, então ele reduzia o sort do DISTINCT ON, não o que
// era expandido.
//
// A observação que destrava: **dia fechado é imutável**. O conjunto de snapshots
// de 01/08 não muda mais nunca. Então o mapa daquele dia pode ser calculado uma
// vez e reusado — por horas, e entre períodos diferentes (mudar o filtro de data
// de 27 pra 20 dias reaproveita os 20 dias já calculados).
//
// ⚠️ O mapa por dia é calculado SEM o filtro de note_id, de propósito: se ele
// dependesse das notas da consulta atual, o cache não serviria pra consulta
// nenhuma além daquela. O preço é guardar mais entradas por dia do que a consulta
// usa; o ganho é pagar o dia uma vez só.
//
// REJEITADO — ler só o ÚLTIMO snapshot de cada (dia, equipe), que cairia de ~170
// mil linhas pra ~1.600: a suíte já prova que isso perde dado. Ver os testes
// "une concluídas de todos os snapshots — recupera a que sumiu do último" e
// "sem união seria só o último (contraste)". Nota SOME de snapshot posterior;
// quem assumir acúmulo muda número em silêncio.
const _memoCacheMod = require('../services/memoCache');
const { dateBRT }   = require('../services/timeUtil');

// Dois caches porque o TTL depende do dia. Dia fechado não recebe snapshot novo
// nunca mais → pode viver horas. O dia CORRENTE ainda está sendo escrito pelo
// cron a cada 15min → mantém o TTL curto de sempre, senão a aba de hoje congela.
const _memoDiaFechado = _memoCacheMod.create({ ttlMs: 12 * 60 * 60 * 1000, name: 'desloc-mapa-dia',  maxEntries: 500 });
const _memoDiaAberto  = _memoCacheMod.create({ ttlMs: 5 * 60 * 1000,       name: 'desloc-mapa-hoje', maxEntries: 60 });

// A chave NÃO inclui note_ids (ver acima) — só o dia e os filtros que realmente
// mudam quais snapshots entram na conta.
function _keyDia(dia, opts) {
  const o = opts || {};
  return JSON.stringify({
    dia,
    teams:     Array.isArray(o.teams) && o.teams.length ? [...o.teams].sort() : (o.team_name || null),
    regionais: Array.isArray(o.regionais) && o.regionais.length ? [...o.regionais].sort() : null,
  });
}

async function _mapaEquipeDoDia(dia, opts = {}) {
  const pool = _getPool();
  const params = [dia];
  let snapWhere = `s.date = $1`;
  // Filtro de regional: `opts.regionais` é string[] de siglas reais (GUA/CAC/SJC).
  // Caller (route) é responsável por garantir array — sem fallback singular.
  if (Array.isArray(opts.regionais) && opts.regionais.length > 0) {
    snapWhere += ` AND ${inRegionalsSql(opts.regionais, params, 's.regional')}`;
  }
  if (Array.isArray(opts.teams) && opts.teams.length > 0) {
    const ph = opts.teams.map(t => { params.push(t); return `$${params.length}`; });
    snapWhere += ` AND s.team_name IN (${ph.join(', ')})`;
  } else if (opts.team_name) {
    params.push(opts.team_name);
    snapWhere += ` AND s.team_name = $${params.length}`;
  }

  // `captured_at` VAI no SELECT porque o merge entre dias precisa dele — ver
  // _mapaEquipeDoPeriodo. Sem ele não dá pra reproduzir o DISTINCT ON global.
  const sql = `
    SELECT DISTINCT ON (nota_item->>'id')
      nota_item->>'id'   AS note_id,
      s.team_name,
      s.regional,
      s.sector_id,
      s.captured_at
    FROM snapshots s,
         LATERAL jsonb_array_elements(
           COALESCE(s.data->'notasConcluidas',  '[]'::jsonb) ||
           COALESCE(s.data->'notasRejeitadas',  '[]'::jsonb) ||
           COALESCE(s.data->'notasExecutadas',  '[]'::jsonb) ||
           COALESCE(s.data->'notasBaixadas',    '[]'::jsonb)
         ) AS nota_item
    WHERE ${snapWhere}
      AND nota_item->>'id' IS NOT NULL
    ORDER BY nota_item->>'id', s.captured_at DESC
  `;
  const { rows } = await pool.query(sql, params);
  // Compacta ANTES de cachear. Isto fica retido por até 12h, vezes o número de
  // dias do período, vezes as combinações de filtro — então o formato importa: o
  // `captured_at` do pg vem como objeto Date, e guardá-lo assim custa memória e
  // ainda obriga a re-parsear a cada merge. Vira número uma vez, aqui.
  return rows.map((r) => ({
    note_id:   r.note_id,
    team_name: r.team_name,
    regional:  r.regional,
    sector_id: r.sector_id,
    ts:        new Date(r.captured_at).getTime(),
  }));
}

const _mapaDiaFechadoCached = _memoDiaFechado.wrap(_mapaEquipeDoDia, _keyDia);
const _mapaDiaAbertoCached  = _memoDiaAberto.wrap(_mapaEquipeDoDia, _keyDia);

// Quantos dias consultar em paralelo. Baixo de propósito: o pool tem 10 conexões
// (PG_POOL_MAX) e o cron escreve nas mesmas tabelas. Ocupar o pool inteiro numa
// consulta de leitura faria o cron enfileirar — que é o cenário do P2-6.
const CONC_DIAS = 4;

/**
 * Monta o mapa note_id → {team_name, regional, sector_id} do período inteiro,
 * juntando os mapas diários.
 *
 * ⚠️ SEMÂNTICA — o merge reproduz, de propósito, o `DISTINCT ON` global que
 * existia antes: para nota que passou por DUAS equipes no período, vence o
 * snapshot de maior `captured_at`, ou seja, a ÚLTIMA equipe a deter a nota.
 * Essa regra foi definida em 21/08/2026 (antes era ordem física, indefinida) e
 * mudar ela mexeria no ranking por equipe sem ninguém pedir. Por isso o merge
 * compara `captured_at` e não a data do dia: são coisas diferentes se algum
 * snapshot for gravado fora de ordem.
 */
async function _mapaEquipeDoPeriodo(de, ate, opts = {}) {
  const dias = [];
  const cur = new Date(de + 'T00:00:00Z');
  const end = new Date(ate + 'T00:00:00Z');
  // Teto de iterações: guarda contra data inválida virar laço infinito. 400 dias
  // é muito além de qualquer uso real (o histórico começa em 09/05/2026).
  while (cur <= end && dias.length < 400) {
    dias.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const hoje = dateBRT();
  const porDia = [];

  for (let i = 0; i < dias.length; i += CONC_DIAS) {
    const lote = dias.slice(i, i + CONC_DIAS);
    const res = await Promise.all(lote.map((d) =>
      // Dia >= hoje ainda está sendo escrito (ou é futuro) → cache curto.
      (d >= hoje ? _mapaDiaAbertoCached : _mapaDiaFechadoCached)(d, opts),
    ));
    for (const rows of res) porDia.push(rows);
  }
  return _mergeMapasDia(porDia);
}

/**
 * Junta os mapas diários num só, aplicando a regra de desempate.
 *
 * Separada e pura DE PROPÓSITO: é a única parte desta mudança que pode alterar
 * número reportado. O resto é cache — se o cache errar, o pior caso é lentidão.
 * Se ISTO errar, o deslocamento vai pra equipe errada e o ranking muda calado.
 * Testada em test/deslocMapaDia.test.js sem precisar de banco.
 *
 * @param {Array<Array<{note_id,team_name,regional,sector_id,ts}>>} porDia
 * @returns {Map<string,{team_name,regional,sector_id}>}
 */
function _mergeMapasDia(porDia) {
  const mapa     = new Map();   // note_id → { team_name, regional, sector_id }
  const vencedor = new Map();   // note_id → captured_at (ms) de quem está ganhando

  for (const rows of porDia) {
    if (!Array.isArray(rows)) continue;
    for (const m of rows) {
      if (!m || !m.note_id) continue;
      const ts = Number(m.ts);
      if (!Number.isFinite(ts)) continue;   // sem carimbo não dá pra desempatar
      const atual = vencedor.get(m.note_id);
      // `>=` e não `>`: em empate de captured_at o primeiro visto permanece, o
      // que mantém o resultado estável entre execuções. O DISTINCT ON do
      // Postgres também é arbitrário no empate; o que não pode é variar.
      if (atual !== undefined && atual >= ts) continue;
      vencedor.set(m.note_id, ts);
      mapa.set(m.note_id, {
        team_name: m.team_name,
        regional:  m.regional,
        sector_id: m.sector_id,
      });
    }
  }
  return mapa;
}

async function listDeslocamentos(de, ate, opts = {}) {
  const pool = _getPool();
  const t0 = Date.now();
  const THRESHOLD = await getThreshold();

  // Estratégia em 4 passos.
  //
  // Passo 1: IDENTIDADE das notas do período (note_id, numero, tipo, first_ts).
  //          Colunas escalares apenas — NÃO toca no jsonb.
  // Passo 2: mapa note_id → {team_name, regional, sector_id} a partir das
  //          snapshots NO PERÍODO (com filtro de regional/team se vier).
  // Passo 3: cruza em memória e aplica whitelist/tipo. Só aqui sabemos QUAIS
  //          notas interessam — e só então (3b) buscamos o payload delas.
  // Passo 4: extrai os pares 0→1 e enriquece com OSRM.
  //
  // 28/08/2026 — a ordem mudou, e o motivo é um BUG DE DADO, não performance.
  // Antes o passo 1 puxava `payload->'checkpoints'` de TODAS as notas do período
  // com `LIMIT 20000` fixo, e só o passo 2 descobria de quem elas eram. Medido em
  // produção (01/08→27/08, perfil admin): 24.610 notas existiam, 20.000 entravam.
  // As 4.610 descartadas saíam pelo `ORDER BY first_ts DESC` — ou seja, sumia o
  // COMEÇO do período, e sumia em silêncio: KPIs, ranking e tendência eram
  // calculados sobre um recorte sem nada na tela dizendo isso.
  //
  // O corte acontecia ANTES de saber a equipe, então ele descartava notas que
  // talvez nem estivessem no escopo do usuário — e ainda assim roubava a vaga
  // das que estavam. Buscar identidade primeiro (barato) e payload só dos
  // sobreviventes (caro) resolve as duas coisas: o teto deixa de ser atingido no
  // uso real e o detoast passa a ser pago só pelo que vai pra tela.

  const params = [de, ate];
  // O filtro pela EXPRESSÃO jsonb não é indexável (o cast pra timestamptz não é
  // IMMUTABLE), então esta variante faz varredura completa de note_details com
  // detoast do jsonb linha a linha — medido em 4,3s só neste passo (21/08/2026).
  // A coluna `first_cp_at` + índice resolvem; a troca fica atrás de flag porque,
  // enquanto o backfill não terminar, usar a coluna ESCONDERIA as notas com
  // first_cp_at NULL. Ligar só depois que scripts/migrar-first-cp-at.js reportar
  // "TEM checkpoint mas sem valor: 0".
  const wherePeriodo = USE_FIRST_CP
    ? `nd.first_cp_at >= $1::date
       AND nd.first_cp_at < ($2::date + interval '1 day')`
    : `
    (nd.payload->'checkpoints'->0->>'timestamp')::timestamptz >= $1::date
    AND (nd.payload->'checkpoints'->0->>'timestamp')::timestamptz < ($2::date + interval '1 day')
  `;

  // ORDER BY timestamp DESC + LIMIT alto: se algum dia bater no teto, perde os
  // dias mais ANTIGOS (previsível), não dias do meio. Antes era LIMIT 3000 sem
  // ORDER, que truncava por ordem física e fazia dias inteiros sumirem do meio
  // do período (ex: 09/10/11/06 sumiam apesar de terem ~1400 notas).
  // Com a flag, o `first_ts` também vem da COLUNA: assim o índice serve o filtro
  // E a ordenação. Se viesse da expressão, o ORDER BY forçaria sort à parte.
  const selFirstTs = USE_FIRST_CP
    ? `nd.first_cp_at AS first_ts`
    : `(nd.payload->'checkpoints'->0->>'timestamp')::timestamptz AS first_ts`;

  // Com a flag, NENHUMA coluna jsonb aparece aqui — nem no SELECT nem no WHERE.
  // O passo 1 vira index scan puro em idx_note_details_first_cp_at, e o detoast
  // dos payloads fica todo para o passo 3b, já filtrado por equipe.
  //
  // O guard `jsonb_array_length(...) >= 2` some do caminho da flag DE PROPÓSITO:
  // exigi-lo aqui obrigaria o detoast que esta mudança existe para evitar. Ele
  // não filtrava nada de fato — nota com 1 checkpoint não tem par 0→1, então
  // extrairDeslocamentos() já devolve [] para ela no passo 4. O resultado final é
  // idêntico; muda só onde a nota é descartada. No caminho SEM flag o guard fica,
  // porque lá o jsonb é lido de qualquer jeito e ele poda linha mais cedo.
  const whereTemCp = USE_FIRST_CP
    ? `nd.first_cp_at IS NOT NULL`
    : `nd.payload->'checkpoints' IS NOT NULL
       AND jsonb_array_length(nd.payload->'checkpoints') >= 2`;

  const sqlNotas = `
    SELECT
      nd.note_id,
      nd.numero,
      nd.tipo,
      ${selFirstTs}
    FROM note_details nd
    WHERE ${whereTemCp}
      AND ${wherePeriodo}
    ORDER BY first_ts DESC
    LIMIT ${MAX_NOTAS_PERIODO}
  `;
  const { rows: rawNotas } = await pool.query(sqlNotas, params);
  const t1 = Date.now();
  const notasTruncadas = rawNotas.length >= MAX_NOTAS_PERIODO;
  console.log(`[deslocamentos] passo 1: ${rawNotas.length} notas do período em ${t1 - t0}ms`
    + (notasTruncadas ? `  ⚠️ TETO ${MAX_NOTAS_PERIODO} ATINGIDO — período truncado` : ''));

  if (rawNotas.length === 0) {
    return { total: 0, returned: 0, rows: [], threshold: THRESHOLD, truncado: false };
  }

  // Passo 2: mapa note_id → equipe, montado DIA A DIA e cacheado por dia.
  // Ver _mapaEquipeDoDia e _mapaEquipeDoPeriodo logo acima deste arquivo.
  const mapaTeam = await _mapaEquipeDoPeriodo(de, ate, opts);
  const t2 = Date.now();
  // ⚠️ Este número SUBIU em relação aos logs de antes de 28/08/2026, e não é
  // regressão: o mapa por dia é montado sem o filtro de note_id (pra poder ser
  // cacheado), então conta TODAS as notas do período, não só as com checkpoint.
  // Comparar com log antigo é comparar coisas diferentes.
  console.log(`[deslocamentos] passo 2: mapa note_id→equipe com ${mapaTeam.size} entradas em ${t2 - t1}ms`);

  // Filtra equipes oficiais (whitelist em equipes_oficiais)
  const { rows: oficRows } = await pool.query(`SELECT sigla FROM equipes_oficiais WHERE ativo = true`);
  const oficiais = new Set(oficRows.map(r => r.sigla));

  // Junta tudo em memória
  const rows = [];
  for (const n of rawNotas) {
    const info = mapaTeam.get(n.note_id);
    if (!info) continue;                                // não tem equipe no período → skip
    if (oficiais.size > 0 && !oficiais.has(info.team_name)) continue;
    if (opts.tipo && n.tipo !== opts.tipo) continue;
    rows.push({
      note_id:    n.note_id,
      numero:     n.numero,
      tipo:       n.tipo,
      team_name:  info.team_name,
      regional:   info.regional,
      sector_id:  info.sector_id,
    });
  }
  const t3 = Date.now();
  console.log(`[deslocamentos] passo 3: ${rows.length} notas finais após join+filtros em ${t3 - t2}ms`);

  if (rows.length === 0) {
    return { total: 0, returned: 0, rows: [], threshold: THRESHOLD, truncado: notasTruncadas };
  }

  // Passo 3b — AGORA sim o jsonb. Só das notas que sobreviveram ao escopo do
  // usuário e à whitelist: é a única leitura cara do pipeline, e ela passou a ser
  // proporcional ao que vai pra tela em vez de ao período inteiro.
  const sqlPayloads = `
    SELECT nd.note_id, nd.payload->'checkpoints' AS checkpoints
      FROM note_details nd
     WHERE nd.note_id = ANY($1::uuid[])
  `;
  const { rows: cpRows } = await pool.query(sqlPayloads, [rows.map(r => r.note_id)]);
  const mapaCp = new Map(cpRows.map(r => [r.note_id, r.checkpoints]));
  const t3b = Date.now();
  console.log(`[deslocamentos] passo 3b: checkpoints de ${cpRows.length} notas em ${t3b - t3}ms`);
  for (const r of rows) r.checkpoints = mapaCp.get(r.note_id) || null;

  const filtered = rows;

  // Expande cada nota em N deslocamentos (N tentativas)
  const desloc = [];
  for (const n of filtered) {
    const pares = extrairDeslocamentos(n.checkpoints);
    for (const p of pares) {
      desloc.push({
        note_id:     n.note_id,
        numero:      n.numero,
        tipo:        n.tipo,
        team_name:   n.team_name,
        regional:    n.regional,
        sector_id:   n.sector_id,
        tentativa:   p.tentativa,
        origem:      p.origem,
        destino:     p.destino,
        tempo_real_sec: p.tempo_real_sec,
        data:        p.origem.ts.slice(0, 10),
      });
    }
  }

  // Limite antes do OSRM pra não estourar quota
  // Cap maximo do enrichment OSRM. 20k pairs = ~10s na 1a consulta com OSRM
  // paralelizado (chunks de 10) e Worker cacheado. Subiu de 5000 -> 20000 pra
  // cobrir periodos de 15 dias inteiros (tipico ~7k notas * ~1.5 pairs = 10k).
  //
  // 28/08/2026 — teto subiu pra MAX_NOTAS_PERIODO pelo mesmo motivo do passo 1:
  // medido em produção, 21.852 deslocamentos eram extraídos e 20.000 processados,
  // então este slice sozinho descartava outros 1.852 em silêncio, EMPILHADO com o
  // corte do passo 1. Agora, quando corta, a resposta diz.
  const LIMIT = Math.min(Math.max(parseInt(opts.limit || 500, 10), 1), MAX_NOTAS_PERIODO);
  const cut = desloc.slice(0, LIMIT);
  const deslocTruncados = desloc.length > cut.length;
  console.log(`[deslocamentos] passo 4: ${desloc.length} deslocamentos extraídos, processando ${cut.length} via OSRM...`
    + (deslocTruncados ? `  ⚠️ ${desloc.length - cut.length} DESCARTADOS pelo teto ${LIMIT}` : ''));
  const tOsrm = Date.now();
  let osrmHits = 0, osrmMisses = 0, osrmFails = 0;

  // Enriquece com OSRM em chunks paralelos. Worker Cloudflare aguenta
  // dezenas de req simultaneas; cache hits sao ~0ms; cache miss ~150ms.
  // Antes era sequencial com throttle 1.1s = 500 pairs * 1.1s = 9min na 1a
  // consulta. Agora chunks de 10 * ~200ms = ~10s na pior hipotese.
  const CHUNK = 10;
  for (let i = 0; i < cut.length; i += CHUNK) {
    const batch = cut.slice(i, i + CHUNK);
    await Promise.all(batch.map(async (d) => {
      const r = await getRoute(d.origem.lat, d.origem.lng, d.destino.lat, d.destino.lng);
      if (r) {
        if (r.cached) osrmHits++; else osrmMisses++;
        d.tempo_osrm_sec = r.duration_sec;
        d.distancia_m    = r.distance_m;
        // 28/08/2026 — `d.geometry = r.geometry` saiu daqui. Era um LineString
        // GeoJSON completo (overview=full) POR DESLOCAMENTO, indo inteiro na
        // resposta: com 20 mil linhas, a geometria era a maior parte do corpo, e
        // o servidor não tem middleware de compressão. Ninguém consumia. O front
        // renderiza 500 linhas de tabela com campos escalares (renderDeslocamentos)
        // e a aba Mapa busca a própria geometria direto do Worker
        // (public/index.html, _fetchRouteGeometry). Continua gravada no
        // `osrm_cache` — some só do corpo da resposta.
        if (d.tempo_osrm_sec === 0) {
          d.desvio_pct = null;
          d.status = 'origem_destino_iguais';
        } else {
          d.desvio_pct = +(100 * (d.tempo_real_sec - d.tempo_osrm_sec) / d.tempo_osrm_sec).toFixed(1);
          // Excedente em segundos (real - osrm). 'lento' exige AMBOS:
          //   desvio > 50% (fator > THRESHOLD)  E  excedente > 15min de tolerância.
          // Isso evita marcar como lento deslocamentos curtos (ex: 2min real vs 1min osrm).
          const excedenteSec    = d.tempo_real_sec - d.tempo_osrm_sec;
          const TOLERANCIA_SEC  = 15 * 60;   // 15 min
          const fatorAcima      = (d.tempo_real_sec / d.tempo_osrm_sec) > THRESHOLD;
          const excedenteAcima  = excedenteSec > TOLERANCIA_SEC;
          d.excedente_sec = excedenteSec;
          d.status = (fatorAcima && excedenteAcima) ? 'lento' : 'ok';
        }
      } else {
        osrmFails++;
        d.tempo_osrm_sec = null;
        d.distancia_m    = null;
        d.desvio_pct     = null;
        d.status         = 'sem_osrm';
      }
    }));
  }
  console.log(`[deslocamentos] passo 4: OSRM concluído em ${((Date.now() - tOsrm) / 1000).toFixed(1)}s — cache hits=${osrmHits} misses=${osrmMisses} fails=${osrmFails}`);

  // Filtro opcional: somente deslocamentos acima do limite (status='lento',
  // que eh real > 1.5x tempo Maps). Aplicado apos enriquecimento OSRM porque
  // precisamos do status calculado. Quando ativo, total/returned refletem
  // so o subconjunto filtrado — usado nos KPIs/tabela/ranking/tendencia
  // pra apresentar visao focada nos problemas.
  // Filtro de "acima": null/todos | 50 | 100 (percentual mínimo de desvio).
  // Sempre exige excedente > 15min (regra de tolerância).
  let finalRows = cut;
  if (opts.acimaPct != null) {
    const pct = Number(opts.acimaPct);
    const TOL = 15 * 60;
    finalRows = cut.filter(d =>
      d.status !== 'sem_osrm'
      && d.tempo_osrm_sec > 0
      && d.desvio_pct != null
      && d.desvio_pct > pct
      && (d.excedente_sec || 0) > TOL
    );
  } else if (opts.somenteLentos) {
    // backward compat — checkbox antigo
    finalRows = cut.filter(d => d.status === 'lento');
  }

  return {
    total: opts.somenteLentos ? finalRows.length : desloc.length,
    returned: finalRows.length,
    rows: finalRows,
    threshold: THRESHOLD,   // UI usa pra rotular "> N× Maps" dinamicamente
    // Truncar é aceitável; truncar em silêncio não. A tela usa isto pra avisar
    // que o período exibido está incompleto, em vez de apresentar um recorte
    // como se fosse o total.
    truncado: notasTruncadas || deslocTruncados,
    descartados: (desloc.length - cut.length) || 0,
  };
}

/** Ranking de equipes por % desvio médio. */
async function rankingEquipes(de, ate, opts = {}) {
  // limit alto: precisamos de TODOS os deslocamentos do periodo pra ranking
  // honesto. Com OSRM paralelizado + Worker cacheado (commit e97691f), 20k
  // pairs sao ~10s na 1a vez e <2s nas subsequentes.
  //
  // 28/08/2026 — tem de ser a MESMA constante que o front manda em `limit`, não
  // um número solto. O `_key` inclui o limit: se este valor divergir do que
  // /lista recebeu, as chaves param de colidir, o single-flight de 21/08 se
  // desfaz e o pipeline caro volta a rodar 3x em paralelo. E pior — o ranking
  // sairia calculado sobre uma lista mais curta que a dos KPIs, dois números
  // discordando na mesma tela. Coberto por test/deslocTruncamento.test.js.
  const lista = await (_listCached || listDeslocamentos)(de, ate, { ...opts, limit: MAX_NOTAS_PERIODO });
  const byTeam = new Map();
  for (const d of lista.rows) {
    if (d.status === 'sem_osrm' || d.tempo_osrm_sec === 0) continue;
    if (!byTeam.has(d.team_name)) {
      byTeam.set(d.team_name, {
        team_name: d.team_name,
        regional:  d.regional,
        total_desloc: 0,
        soma_desvio: 0,
        lentos: 0,
      });
    }
    const acc = byTeam.get(d.team_name);
    acc.total_desloc++;
    acc.soma_desvio += d.desvio_pct;
    if (d.status === 'lento') acc.lentos++;
  }
  const ranking = Array.from(byTeam.values()).map(t => ({
    ...t,
    desvio_medio_pct: t.total_desloc > 0 ? +(t.soma_desvio / t.total_desloc).toFixed(1) : 0,
    pct_lentos: t.total_desloc > 0 ? +(100 * t.lentos / t.total_desloc).toFixed(1) : 0,
  }));
  ranking.sort((a, b) => b.desvio_medio_pct - a.desvio_medio_pct);
  return ranking;
}

/** Tendência diária: tempo médio real vs Maps por dia, com continuidade de calendário. */
async function tendenciaDiaria(de, ate, opts = {}) {
  // limit alto: tendencia precisa amostrar todos os dias do periodo, nao so os
  // mais recentes. Antes era 5000 e dias antigos sumiam quando rawNotas DESC
  // truncava neles. Com OSRM paralelizado, 20k pairs = ~10s 1a vez.
  // Mesma constante que o ranking e que o front — ver nota em rankingEquipes.
  const lista = await (_listCached || listDeslocamentos)(de, ate, { ...opts, limit: MAX_NOTAS_PERIODO });
  const byDay = new Map();
  for (const d of lista.rows) {
    if (d.status === 'sem_osrm') continue;
    if (!byDay.has(d.data)) {
      byDay.set(d.data, { data: d.data, total: 0, soma_real: 0, soma_osrm: 0, lentos: 0 });
    }
    const acc = byDay.get(d.data);
    acc.total++;
    acc.soma_real += d.tempo_real_sec;
    acc.soma_osrm += d.tempo_osrm_sec;
    if (d.status === 'lento') acc.lentos++;
  }

  // Garante continuidade do calendario [de, ate] preenchendo zero em dias
  // sem deslocamentos (mesma logica de getRejeicoesTotais.porDia).
  const out = [];
  if (de && ate) {
    const cur = new Date(de + 'T00:00:00Z');
    const end = new Date(ate + 'T00:00:00Z');
    while (cur <= end) {
      const isoDate = cur.toISOString().slice(0, 10);
      const d = byDay.get(isoDate);
      if (d && d.total > 0) {
        out.push({
          data:               isoDate,
          total:              d.total,
          tempo_real_avg_sec: Math.round(d.soma_real / d.total),
          tempo_osrm_avg_sec: Math.round(d.soma_osrm / d.total),
          pct_lentos:         +(100 * d.lentos / d.total).toFixed(1),
        });
      } else {
        out.push({
          data:               isoDate,
          total:              0,
          tempo_real_avg_sec: 0,
          tempo_osrm_avg_sec: 0,
          pct_lentos:         0,
        });
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return out;
}

// ── Cache de resultado: TTL 5min + single-flight ─────────────────────────────
// Snapshots atualizam a cada 15min (cronService). TTL de 5min mantem os dados
// "frescos o suficiente".
//
// CORRECAO 21/08/2026: este comentario afirmava que o cache "reduz drasticamente
// o re-trabalho quando o front dispara lista/ranking/tendencia em paralelo com
// mesmos filtros". Nao reduzia — as chaves sao por funcao, entao as tres chamadas
// geravam tres chaves distintas e o single-flight nunca colidia. O
// compartilhamento agora vem de as derivadas chamarem a lista CACHEADA (ver
// _listCached no topo) + o limit normalizado no _key.
const _memo = require('../services/memoCache').create({
  ttlMs: 5 * 60 * 1000,
  name:  'deslocamentos',
});

function _key(prefix, de, ate, opts) {
  // Normaliza: aceita teams/regionais como array (multi) ou singular.
  const o = opts || {};
  return JSON.stringify({
    fn:        prefix,
    de, ate,
    teams:     Array.isArray(o.teams)     ? [...o.teams].sort()     : o.team_name || null,
    regionais: Array.isArray(o.regionais) ? [...o.regionais].sort() : null,
    tipo:      o.tipo  || null,
    limit:     o.limit != null && o.limit !== '' ? Number(o.limit) : null,   // string da querystring x numero interno (21/08)
    somenteLentos: !!o.somenteLentos,
    acimaPct:      o.acimaPct != null ? Number(o.acimaPct) : null,
  });
}

const listDeslocamentosCached = _memo.wrap(listDeslocamentos,
  (de, ate, opts) => _key('list', de, ate, opts));
_listCached = listDeslocamentosCached;   // ver nota no topo: as derivadas reusam esta
const rankingEquipesCached    = _memo.wrap(rankingEquipes,
  (de, ate, opts) => _key('rank', de, ate, opts));
const tendenciaDiariaCached   = _memo.wrap(tendenciaDiaria,
  (de, ate, opts) => _key('tend', de, ate, opts));

module.exports = {
  // Versões cacheadas (uso normal — usado pelos endpoints HTTP)
  listDeslocamentos: listDeslocamentosCached,
  rankingEquipes:    rankingEquipesCached,
  tendenciaDiaria:   tendenciaDiariaCached,
  // Versões cruas (mantidas pra eventual uso direto sem cache)
  _listDeslocamentosRaw: listDeslocamentos,
  _rankingEquipesRaw:    rankingEquipes,
  _tendenciaDiariaRaw:   tendenciaDiaria,
  // Resto
  extrairDeslocamentos,
  _key,   // exportado p/ teste: a chave decide se as 3 rotas compartilham o calculo
  // exportados p/ teste: a regra de desempate entre dias é a única parte do
  // cache por dia que pode mudar a equipe de um deslocamento.
  _mergeMapasDia,
  _keyDia,
  // exportado p/ teste: o front manda `limit` na querystring e o backend corta
  // por este teto. Se os dois divergirem, a tela trunca de novo — em silêncio.
  MAX_NOTAS_PERIODO,
  getThreshold,
  setThresholdCache,
  _memo,   // exposto pra debug/invalidate manual via rota admin se quiser
};
