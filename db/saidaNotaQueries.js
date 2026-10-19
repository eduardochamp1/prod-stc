/**
 * db/saidaNotaQueries.js
 *
 * Acesso a dados da aba "Saída da nota" (P2-70, 017_saida_nota.sql) — os DOIS
 * bancos: o do WPA Monitor (`pool`) e o do gseq (`poolGseq`, só leitura).
 * Camada FINA: a regra mora em services/saidaNota.js; a orquestração em
 * services/saidaNotaJob.js. Toda função recebe o pool — o teste injeta um falso.
 *
 * Spec: docs/handoff/SPEC-saida-da-nota-2026-10-18.md.
 */

'use strict';

const { inRegionalsSql } = require('../services/regionals');
const { placaDoNome } = require('../services/saidaNota');

// ── WPA Monitor: leitura para o job ─────────────────────────────────────────

/**
 * Notas concluídas no dia D (snapshots) de equipes da whitelist, com o detalhe
 * da nota (checkpoints e endereço). Nota sem detalhe vem com `checkpoints` null.
 * A mesma nota aparece em snapshots de vários dias — quem chama decide pelo dia
 * em que a execução começou (deduplicação do 1º backtest, 18/10/2026).
 */
async function notasConcluidasDoDia(pool, data) {
  const { rows: notas } = await pool.query(`
    SELECT DISTINCT ON (n->>'id')
           n->>'id'                AS note_id,
           upper(s.team_name)      AS equipe,
           s.regional
      FROM public.snapshots s
      JOIN public.equipes_oficiais eo
        ON upper(eo.sigla) = upper(s.team_name) AND eo.ativo = true,
           LATERAL jsonb_array_elements(COALESCE(s.data->'notasConcluidas', '[]'::jsonb)) n
     WHERE s.date = $1::date
       AND n->>'id' IS NOT NULL
     ORDER BY n->>'id', s.captured_at DESC`, [data]);
  if (notas.length === 0) return [];
  const { rows: det } = await pool.query(`
    SELECT note_id::text AS note_id, numero, tipo,
           payload->'checkpoints' AS checkpoints,
           payload->'endereco'    AS endereco
      FROM public.note_details
     WHERE note_id = ANY($1::uuid[])`, [notas.map(n => n.note_id)]);
  const porId = new Map(det.map(d => [d.note_id, d]));
  return notas.map(n => {
    const d = porId.get(n.note_id);
    return { ...n, numero: d ? d.numero : null, tipo: d ? d.tipo : null,
      checkpoints: d ? d.checkpoints : null, endereco: d ? d.endereco : null };
  });
}

/**
 * Pausas apontadas na sessão (`sessao_intervalo`), dia ±1 (execução pode cruzar
 * a meia-noite). Map equipe → [{ini, fim, motivo}] em ms.
 * ⚠️ FUSO (P1-48): `inicio`/`fim` são hora de PAREDE gravada com 'Z' errado —
 * `AT TIME ZONE 'UTC'` desfaz o 'Z', como em db/heQueries.js:519-521.
 */
async function intervalosDoDia(pool, data) {
  const { rows } = await pool.query(`
    SELECT upper(btrim(equipe)) AS equipe, motivo,
           to_char(inicio AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS inicio,
           to_char(fim    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS fim
      FROM public.sessao_intervalo
     WHERE data BETWEEN ($1::date - 1) AND ($1::date + 1)
       AND fim IS NOT NULL`, [data]);
  const out = new Map();
  for (const r of rows) {
    const ini = Date.parse(`${r.inicio}-03:00`), fim = Date.parse(`${r.fim}-03:00`);
    if (!Number.isFinite(ini) || !Number.isFinite(fim) || fim <= ini) continue;
    if (!out.has(r.equipe)) out.set(r.equipe, []);
    out.get(r.equipe).push({ ini, fim, motivo: r.motivo });
  }
  return { porEquipe: out, linhas: rows.length };
}

// ── gseq (só leitura) ────────────────────────────────────────────────────────

/** Cadastro Equipes × Veículos do gseq. */
async function alocacoesGseq(poolGseq) {
  const { rows } = await poolGseq.query(`
    SELECT upper(sigla) AS sigla, placa, tipo, desde, ate FROM equipes_veiculos`);
  return rows;
}

/**
 * Trilha das placas pedidas no intervalo. Map placa (sem separador) → pontos.
 * O nome da unidade traz sufixo ("TLF-3E65 / 24 HORAS") — casa por substring da
 * placa. Filtro em "recordedAt" usa o índice; +3h cobre ponto que chegou atrasado.
 */
async function trilhaDasPlacas(poolGseq, placas, iniMs, fimMs) {
  const out = new Map();
  if (!placas.length) return out;
  const { rows } = await poolGseq.query(`
    SELECT regexp_replace(upper(vehicle), '[^A-Z0-9]', '', 'g') AS v,
           lat, lon, ignition, COALESCE("eventAt", "recordedAt") AS t
      FROM vehicle_positions
     WHERE "recordedAt" >= $1 AND "recordedAt" < $2
       AND regexp_replace(upper(vehicle), '[^A-Z0-9]', '', 'g') LIKE ANY ($3::text[])`,
    [new Date(iniMs), new Date(fimMs + 3 * 3600000), placas.map(p => `%${p}%`)]);
  for (const r of rows) {
    const t = new Date(r.t).getTime();
    if (t < iniMs || t > fimMs) continue;
    const placa = placas.find(pl => r.v.includes(pl));
    if (!placa) continue;
    if (!out.has(placa)) out.set(placa, []);
    out.get(placa).push({ t, lat: Number(r.lat), lon: Number(r.lon), ign: r.ignition === true });
  }
  for (const pts of out.values()) pts.sort((a, b) => a.t - b.t);
  return out;
}

/** Baldes de 5 min em que a FROTA gravou algum ponto (pulso da ingestão). */
async function baldesFrota(poolGseq, iniMs, fimMs) {
  const { rows } = await poolGseq.query(`
    SELECT DISTINCT floor(extract(epoch FROM "recordedAt") / 300)::bigint AS b
      FROM vehicle_positions
     WHERE "recordedAt" >= $1 AND "recordedAt" < $2`,
    [new Date(iniMs), new Date(fimMs)]);
  return new Set(rows.map(r => Number(r.b)));
}

/**
 * Frota inteira no intervalo (para a sugestão de placa, SPEC A7). Map placa →
 * pontos ordenados. Só a placa extraída do nome sai daqui (LGPD).
 */
async function frotaNoIntervalo(poolGseq, iniMs, fimMs) {
  const { rows } = await poolGseq.query(`
    SELECT vehicle, lat, lon, COALESCE("eventAt", "recordedAt") AS t
      FROM vehicle_positions
     WHERE "recordedAt" >= $1 AND "recordedAt" < $2`,
    [new Date(iniMs), new Date(fimMs + 3 * 3600000)]);
  const frota = new Map();
  for (const r of rows) {
    const t = new Date(r.t).getTime();
    if (t < iniMs || t > fimMs) continue;
    const placa = placaDoNome(r.vehicle);
    if (!placa) continue;
    if (!frota.has(placa)) frota.set(placa, []);
    frota.get(placa).push({ t, lat: Number(r.lat), lon: Number(r.lon) });
  }
  for (const pts of frota.values()) pts.sort((a, b) => a.t - b.t);
  return frota;
}

// ── WPA Monitor: gravação ────────────────────────────────────────────────────

const COLUNAS = ['note_id', 'data', 'equipe', 'regional', 'numero', 'tipo', 'status', 'motivo',
  'placa', 'placa_fonte', 'inicio', 'fim', 'ancora_lat', 'ancora_lon', 'ancora_fonte',
  'dist_max_m', 'min_fora', 'km', 'saidas', 'trilha', 'ponto_max',
  'd_veiculo_tablet_m', 'd_cadastro_tablet_m', 'pausa_descontada_min',
  'veiculos_junto', 'ocorrencia_id', 'regra_versao'];
const JSONB = new Set(['saidas', 'trilha', 'ponto_max']);

/** Linha do job → valores na ordem de COLUNAS. Pura. */
function valoresDaLinha(l) {
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const v = {
    note_id: l.note_id, data: l.data, equipe: l.equipe, regional: l.regional,
    numero: l.numero ?? null, tipo: l.tipo ?? null, status: l.status, motivo: l.motivo ?? null,
    placa: l.placa ?? null, placa_fonte: l.placaFonte ?? null,
    inicio: iso(l.janela && l.janela.inicio), fim: iso(l.janela && l.janela.fim),
    ancora_lat: l.ancora ? l.ancora.lat : null, ancora_lon: l.ancora ? l.ancora.lon : null,
    ancora_fonte: l.ancora ? l.ancora.fonte : null,
    dist_max_m: l.distMaxM ?? null, min_fora: l.minFora ?? null, km: l.km ?? null,
    saidas: l.saidas ?? null, trilha: l.trilha ?? null, ponto_max: l.pontoMax ?? null,
    d_veiculo_tablet_m: l.dVeiculoTabletM ?? null, d_cadastro_tablet_m: l.dCadastroTabletM ?? null,
    pausa_descontada_min: l.pausaDescontadaMin ?? null,
    veiculos_junto: l.veiculosJunto && l.veiculosJunto.length ? l.veiculosJunto : null,
    ocorrencia_id: l.ocorrenciaId ?? null, regra_versao: l.regraVersao,
  };
  return COLUNAS.map(c => (JSONB.has(c) && v[c] !== null ? JSON.stringify(v[c]) : v[c]));
}

/**
 * Upsert idempotente por note_id, em lotes. Rodar o mesmo dia de novo substitui
 * a linha (inclusive `calculado_em`). Devolve quantas linhas gravou.
 */
async function gravar(pool, linhas, lote = 200) {
  let n = 0;
  for (let i = 0; i < linhas.length; i += lote) {
    const fatia = linhas.slice(i, i + lote);
    const params = [];
    const tuplas = fatia.map(l => {
      const vals = valoresDaLinha(l);
      const ph = vals.map((v, k) => {
        params.push(v);
        const c = COLUNAS[k];
        const cast = JSONB.has(c) ? '::jsonb' : c === 'data' ? '::date' : c === 'note_id' ? '::uuid'
          : (c === 'inicio' || c === 'fim') ? '::timestamptz' : c === 'veiculos_junto' ? '::text[]' : '';
        return `$${params.length}${cast}`;
      });
      return `(${ph.join(', ')}, now())`;
    });
    const set = COLUNAS.filter(c => c !== 'note_id').map(c => `${c} = EXCLUDED.${c}`).join(', ');
    await pool.query(
      `INSERT INTO public.saida_nota (${COLUNAS.join(', ')}, calculado_em)
       VALUES ${tuplas.join(',\n              ')}
       ON CONFLICT (note_id) DO UPDATE SET ${set}, calculado_em = now()`, params);
    n += fatia.length;
  }
  return n;
}

// ── WPA Monitor: leitura para a tela ─────────────────────────────────────────

function _filtros({ de, ate, regionals, equipes }, params) {
  params.push(de, ate);
  let w = `data BETWEEN $1::date AND $2::date`;
  if (Array.isArray(regionals) && regionals.length) w += ` AND ${inRegionalsSql(regionals, params)}`;
  if (Array.isArray(equipes) && equipes.length) {
    params.push(equipes.map(e => String(e).toUpperCase()));
    w += ` AND equipe = ANY($${params.length}::text[])`;
  }
  return w;
}

/** Contagem por equipe × status no período (KPIs e cobertura). */
async function contagemPorEquipeStatus(pool, f) {
  const params = [];
  const { rows } = await pool.query(`
    SELECT equipe, regional, status, count(*)::int AS n,
           array_remove(array_agg(DISTINCT placa), NULL) AS placas
      FROM public.saida_nota
     WHERE ${_filtros(f, params)}
     GROUP BY equipe, regional, status`, params);
  return rows;
}

/** Ocorrências (indicador 1 e 2) do período, sem a trilha (pesada). */
async function ocorrencias(pool, f) {
  const params = [];
  const { rows } = await pool.query(`
    SELECT note_id, to_char(data, 'YYYY-MM-DD') AS data, equipe, regional, numero, tipo, status,
           placa, inicio, fim, dist_max_m, min_fora, km, saidas, ponto_max,
           ancora_lat, ancora_lon, ancora_fonte, d_veiculo_tablet_m, d_cadastro_tablet_m,
           pausa_descontada_min, ocorrencia_id
      FROM public.saida_nota
     WHERE ${_filtros(f, params)}
       AND status IN ('saiu', 'longe_do_local')
     ORDER BY data DESC, inicio DESC`, params);
  return rows;
}

/** Placas que o rastreador viu junto do tablet, por equipe (sugestão, SPEC A7). */
async function veiculosJuntoPorEquipe(pool, f) {
  const params = [];
  const { rows } = await pool.query(`
    SELECT equipe, v AS placa, count(*)::int AS n
      FROM public.saida_nota, unnest(veiculos_junto) AS v
     WHERE ${_filtros(f, params)}
     GROUP BY equipe, v`, params);
  return rows;
}

/** Detalhe de uma nota, só se a regional dela estiver no escopo. */
async function detalhe(pool, noteId, regionals) {
  const params = [noteId];
  let w = 'note_id = $1::uuid';
  if (Array.isArray(regionals) && regionals.length) w += ` AND ${inRegionalsSql(regionals, params)}`;
  const { rows } = await pool.query(`
    SELECT note_id, to_char(data, 'YYYY-MM-DD') AS data, equipe, regional, numero, tipo, status, motivo,
           placa, placa_fonte, inicio, fim, ancora_lat, ancora_lon, ancora_fonte,
           dist_max_m, min_fora, km, saidas, trilha, ponto_max,
           d_veiculo_tablet_m, d_cadastro_tablet_m, pausa_descontada_min, ocorrencia_id,
           regra_versao, calculado_em
      FROM public.saida_nota
     WHERE ${w}`, params);
  return rows[0] || null;
}

/** Notas executadas junto com esta (mesma ocorrência), também recortadas pelo escopo. */
async function notasDaOcorrencia(pool, ocorrenciaId, regionals) {
  if (!ocorrenciaId) return [];
  const params = [ocorrenciaId];
  let w = 'ocorrencia_id = $1';
  if (Array.isArray(regionals) && regionals.length) w += ` AND ${inRegionalsSql(regionals, params)}`;
  const { rows } = await pool.query(`
    SELECT note_id, numero, tipo, status FROM public.saida_nota
     WHERE ${w} ORDER BY inicio`, params);
  return rows;
}

module.exports = {
  notasConcluidasDoDia, intervalosDoDia,
  alocacoesGseq, trilhaDasPlacas, baldesFrota, frotaNoIntervalo,
  COLUNAS, valoresDaLinha, gravar,
  contagemPorEquipeStatus, ocorrencias, veiculosJuntoPorEquipe, detalhe, notasDaOcorrencia,
};
