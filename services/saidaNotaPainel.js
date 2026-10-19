'use strict';

/**
 * services/saidaNotaPainel.js — monta a resposta da aba "Saída da nota" (P2-70)
 * a partir do que está gravado em `saida_nota`. PURA (testada).
 *
 * Três blocos (SPEC-saida-da-nota-2026-10-18.md §9):
 *   - kpis: cobertura, saídas, executadas longe, pausas descontadas;
 *   - ocorrencias: notas executadas juntas viram UMA ocorrência (SPEC A4);
 *   - cobertura: por equipe, quanto ficou de fora e por quê (lista de trabalho
 *     da operação), com a placa que o rastreador sugere (SPEC A7).
 */

const AVALIADAS = new Set(['ok', 'saiu', 'saiu_em_intervalo']);
const FORA_DA_CONTA = ['sem_placa', 'veiculo_divergente', 'sem_trilha', 'rastreador_fora',
  'sem_janela', 'fora_no_inicio'];

/** Sugestão de placa por equipe: a mais vista junto do tablet. */
function _sugestoes(veiculosJunto, notasPorEquipe) {
  const porEquipe = new Map();
  for (const r of veiculosJunto || []) {
    const atual = porEquipe.get(r.equipe);
    if (!atual || r.n > atual.n) porEquipe.set(r.equipe, { placa: r.placa, n: r.n });
  }
  const out = new Map();
  for (const [eq, s] of porEquipe) {
    const base = notasPorEquipe.get(eq) || 0;
    out.set(eq, { placa: s.placa, notas: s.n, pct: base ? Math.round((100 * s.n) / base) : 0 });
  }
  return out;
}

/**
 * @param {Array} contagens   [{equipe, regional, status, n, placas}]
 * @param {Array} linhas      ocorrências gravadas (status saiu | longe_do_local)
 * @param {Array} veiculosJunto [{equipe, placa, n}]
 */
function montarPainel(contagens, linhas, veiculosJunto) {
  const porStatus = {};
  const equipes = new Map();
  for (const c of contagens || []) {
    porStatus[c.status] = (porStatus[c.status] || 0) + c.n;
    if (!equipes.has(c.equipe)) {
      equipes.set(c.equipe, { equipe: c.equipe, regional: c.regional, total: 0, avaliadas: 0,
        saiu: 0, longe: 0, porStatus: {}, placas: new Set() });
    }
    const e = equipes.get(c.equipe);
    e.total += c.n;
    e.porStatus[c.status] = (e.porStatus[c.status] || 0) + c.n;
    if (AVALIADAS.has(c.status)) e.avaliadas += c.n;
    for (const p of c.placas || []) e.placas.add(p);
  }

  // Ocorrências: agrupa por ocorrencia_id (notas executadas juntas) + status.
  const grupos = new Map();
  for (const l of linhas || []) {
    const k = `${l.status}|${l.ocorrencia_id || l.note_id}`;
    if (!grupos.has(k)) {
      grupos.set(k, {
        id: l.ocorrencia_id || l.note_id, status: l.status, data: l.data, equipe: l.equipe,
        regional: l.regional, placa: l.placa, inicio: l.inicio, fim: l.fim,
        minFora: 0, distMaxM: 0, km: 0, saidas: l.saidas || [], pontoMax: l.ponto_max,
        ancora: l.ancora_lat != null ? { lat: l.ancora_lat, lon: l.ancora_lon, fonte: l.ancora_fonte } : null,
        dVeiculoTabletM: l.d_veiculo_tablet_m, dCadastroTabletM: l.d_cadastro_tablet_m,
        pausaDescontadaMin: l.pausa_descontada_min || 0, notas: [],
      });
    }
    const g = grupos.get(k);
    g.notas.push({ note_id: l.note_id, numero: l.numero, tipo: l.tipo });
    g.minFora = Math.max(g.minFora, l.min_fora || 0);
    if ((l.dist_max_m || 0) > g.distMaxM) { g.distMaxM = l.dist_max_m || 0; g.pontoMax = l.ponto_max; g.saidas = l.saidas || []; }
    g.km = Math.max(g.km, Number(l.km) || 0);
    if (l.inicio < g.inicio) g.inicio = l.inicio;
    if (l.fim > g.fim) g.fim = l.fim;
  }
  const ocorrencias = [...grupos.values()].sort((a, b) =>
    (b.minFora || 1) * b.distMaxM - (a.minFora || 1) * a.distMaxM);

  for (const o of ocorrencias) {
    const e = equipes.get(o.equipe);
    if (!e) continue;
    if (o.status === 'saiu') e.saiu++; else e.longe++;
  }

  const total = Object.values(porStatus).reduce((a, b) => a + b, 0);
  const avaliadas = [...AVALIADAS].reduce((a, s) => a + (porStatus[s] || 0), 0);
  const ocSaiu = ocorrencias.filter(o => o.status === 'saiu').length;
  const ocLonge = ocorrencias.filter(o => o.status === 'longe_do_local').length;

  const notasPorEquipe = new Map([...equipes.values()].map(e => [e.equipe, e.total]));
  const sug = _sugestoes(veiculosJunto, notasPorEquipe);
  const cobertura = [...equipes.values()].map(e => ({
    equipe: e.equipe, regional: e.regional, total: e.total, avaliadas: e.avaliadas,
    pctAvaliadas: e.total ? Math.round((100 * e.avaliadas) / e.total) : 0,
    saiu: e.saiu, longe: e.longe, porStatus: e.porStatus, placas: [...e.placas],
    foraDaConta: FORA_DA_CONTA.reduce((a, s) => a + (e.porStatus[s] || 0), 0),
    sugestao: sug.get(e.equipe) || null,
  })).sort((a, b) => b.foraDaConta - a.foraDaConta || a.equipe.localeCompare(b.equipe));

  return {
    kpis: {
      concluidas: total,
      avaliadas,
      pctAvaliadas: total ? Math.round((1000 * avaliadas) / total) / 10 : 0,
      notasSaiu: porStatus.saiu || 0,
      ocorrenciasSaiu: ocSaiu,
      pctSaiu: avaliadas ? Math.round((1000 * (porStatus.saiu || 0)) / avaliadas) / 10 : 0,
      ocorrenciasLonge: ocLonge,
      saiuEmIntervalo: porStatus.saiu_em_intervalo || 0,
      patrulha: porStatus.patrulha || 0,
      porStatus,
    },
    ocorrencias,
    cobertura,
  };
}

module.exports = { montarPainel, AVALIADAS, FORA_DA_CONTA };
