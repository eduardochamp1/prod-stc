/**
 * db/logoffSync.js
 *
 * Casa o logoff que a EDP tem com o snapshot que ficou sem fim.
 *
 * Extraído de `services/cronService.js:runSyncLogoffs` em 09/09/2026, junto com
 * o conserto do P1-47. Um único lugar, usado pelo cron E pelo script de
 * recuperação — antes eram duas implementações, e a do script achava 113 fins
 * que a do cron não achava.
 *
 * ── OS TRÊS DEFEITOS QUE ISTO CONSERTA ──────────────────────────────────────
 *
 * 1. HORÁRIO. O cron roda às 03:00 e processava só D-1. Turno que entra 20:00 e
 *    sai 05:00 ainda está ABERTO às 03:00 — o job o via sem `EndTime`, pulava, e
 *    nunca voltava àquela data. Perdia a prorrogação de TODO turno noturno.
 *    Conserto: processar **D-1 e D-2**. Com D-2 o turno tem ~24h pra fechar
 *    antes de a gente perguntar, e o horário do cron deixa de importar.
 *
 * 2. JANELA DE BUSCA. O job procurava o snapshot com
 *        .gte('date', date).order('captured_at', DESC).limit(20)
 *    Para "ontem" funciona: os 20 mais recentes são do dia certo. Para
 *    qualquer data mais antiga são de dias/semanas DEPOIS, e o alvo nunca entra
 *    na janela — então acrescentar D-2 sem consertar isto não resolveria nada.
 *    Medido em 09/09: recuperou 0 de 113 em 16 datas com a EDP devolvendo
 *    dezenas de fins por dia. Conserto: buscar por (equipe, session_begin)
 *    direto, sem janela.
 *
 * 3. COMPARAÇÃO DE INSTANTE. O job casava por string exata
 *    (`sb1 === beginTime`). '20:00:55', '20:00:55.000' e '20:00:55-03:00' são
 *    o MESMO instante e nenhuma casa com a outra por string. Conserto: comparar
 *    o instante normalizado por `msParede` (hora de parede BRT — ver o
 *    cabeçalho de `db/heQueries.js` pra saber por que não se converte fuso).
 *
 * E grava **coluna `session_end` E `data->>'sessionEnd'`** em sincronia. O job
 * antigo gravava só o jsonb, e foi essa dessincronia que fez a Medição HE ler o
 * campo errado e tratar 164 sessões como abertas.
 */

'use strict';

const { msParede } = require('./heQueries');

/** Sentinela de "sem fim" que a API da EDP devolve. */
const VAZIO_EDP = '0001-01-01T00:00:00';

/**
 * FUNÇÃO PURA (testável): chave de casamento de uma sessão.
 *
 * `EQUIPE|instanteEmMs`. A equipe entra normalizada (a EDP e o snapshot
 * divergem em caixa e espaço) e o início como INSTANTE, não como texto — é o
 * que faz milissegundo e offset pararem de importar.
 *
 * null quando não dá pra formar chave confiável. Chave frouxa casaria sessão
 * errada e gravaria o fim de outra equipe.
 */
function chaveSessao(nomeEquipe, inicioISO) {
  const nome = String(nomeEquipe || '').toUpperCase().trim();
  const ms = msParede(inicioISO);
  if (!nome || ms == null) return null;
  return `${nome}|${ms}`;
}

/**
 * FUNÇÃO PURA (testável): índice das sessões FECHADAS que a EDP devolveu.
 *
 * Só entra sessão da Engelmig e com `EndTime` real — a EDP usa
 * '0001-01-01T00:00:00' pra "sem fim", e gravar isso como logoff criaria uma
 * prorrogação negativa de dois mil anos.
 */
function indexarFechadas(sessoes, companyId) {
  const mapa = new Map();
  for (const s of (sessoes || [])) {
    if (!s) continue;
    if (companyId && s.Team && s.Team.CompanyId !== companyId) continue;
    if (!s.EndTime || s.EndTime === VAZIO_EDP) continue;
    const k = chaveSessao(
      (s.Team && (s.Team.Name || s.Team.ExternalReference)) || null, s.BeginTime);
    if (k) mapa.set(k, s.EndTime);
  }
  return mapa;
}

/**
 * Sessões do dia que estão SEM fim, com o setor de cada uma.
 *
 * O dia é o do `session_begin`, não o do snapshot: sessão que vira a meia-noite
 * é gravada em snapshots de dois dias e pertence ao dia em que começou — mesma
 * regra de `db/queries.js:377` e da Medição HE.
 */
async function sessoesSemFim(pool, dia) {
  const { rows } = await pool.query(
    `WITH ultimo AS (
       SELECT DISTINCT ON (team_name, session_begin)
              upper(btrim(team_name)) AS equipe, sector_id, session_begin,
              COALESCE(session_end, data->>'sessionEnd', data->>'session_end') AS fim
         FROM public.snapshots
        WHERE date BETWEEN $1::date AND ($1::date + 2)
          AND session_begin IS NOT NULL
        ORDER BY team_name, session_begin, captured_at DESC
     )
     SELECT equipe, sector_id, session_begin
       FROM ultimo
      WHERE fim IS NULL
        AND substring(session_begin, 1, 10) = $2
      ORDER BY equipe`,
    [dia, dia]);
  return rows;
}

/**
 * Grava o fim numa sessão, na COLUNA e no JSONB.
 *
 * O `WHERE` exige fim ausente: é o que torna a operação idempotente e impede
 * sobrescrever logoff já conhecido. Devolve quantas linhas foram tocadas —
 * podem ser várias, porque a mesma sessão aparece em todos os snapshots do
 * período em que ficou aberta.
 */
async function gravarFim(pool, equipe, sessionBegin, fim) {
  const { rowCount } = await pool.query(
    `UPDATE public.snapshots
        SET session_end = $3,
            data = jsonb_set(COALESCE(data, '{}'::jsonb), '{sessionEnd}',
                             to_jsonb($3::text), true)
      WHERE upper(btrim(team_name)) = $1
        AND session_begin = $2
        AND COALESCE(session_end, data->>'sessionEnd', data->>'session_end') IS NULL`,
    [equipe, sessionBegin, fim]);
  return rowCount;
}

/**
 * Sincroniza os fins de um dia.
 *
 * Consulta a EDP só nos setores que TÊM sessão sem fim naquele dia — o job
 * antigo varria os quatro sempre, gastando chamada onde não havia nada a fazer.
 *
 * @param {object}   pool
 * @param {Function} buscarSessoes  (setor, dia) → sessões da EDP
 * @param {string}   dia            'YYYY-MM-DD'
 * @param {object}   opts { companyId, setorDesabilitado?, log? }
 */
async function sincronizarDia(pool, buscarSessoes, dia, opts = {}) {
  const log = opts.log || (() => {});
  const abertas = await sessoesSemFim(pool, dia);
  if (!abertas.length) {
    log(`[logoff-sync] ${dia}: nenhuma sessão sem fim`);
    return { dia, abertas: 0, gravadas: 0, semPar: 0, falhas: [] };
  }

  const setores = [...new Set(abertas.map(a => a.sector_id))].filter(Boolean);
  const indice = new Map();
  const falhas = [];
  for (const setor of setores) {
    if (opts.setorDesabilitado && opts.setorDesabilitado(setor)) {
      log(`[logoff-sync] ${dia} ${setor}: conta desativada, pulando`);
      continue;
    }
    try {
      const sessoes = await buscarSessoes(setor, dia);
      indice.set(setor, indexarFechadas(sessoes, opts.companyId));
    } catch (err) {
      falhas.push({ setor, erro: err.message });
      log(`[logoff-sync] ${dia} ${setor}: falhou — ${err.message}`);
    }
  }

  let gravadas = 0, semPar = 0;
  for (const a of abertas) {
    const mapa = indice.get(a.sector_id);
    if (!mapa) continue;                      // setor pulado ou falhou
    const k = chaveSessao(a.equipe, a.session_begin);
    const fim = k ? mapa.get(k) : null;
    if (!fim) { semPar++; continue; }
    if (await gravarFim(pool, a.equipe, a.session_begin, fim) > 0) gravadas++;
  }

  log(`[logoff-sync] ${dia}: ${gravadas} de ${abertas.length} recuperada(s)`
    + (semPar ? `, ${semPar} sem par na EDP` : ''));
  return { dia, abertas: abertas.length, gravadas, semPar, falhas };
}

/** 'YYYY-MM-DD' menos N dias, sem depender do fuso do processo. */
function diaMenos(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');     // meio-dia evita borda de DST
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  VAZIO_EDP,
  chaveSessao,
  indexarFechadas,
  sessoesSemFim,
  gravarFim,
  sincronizarDia,
  diaMenos,
};
