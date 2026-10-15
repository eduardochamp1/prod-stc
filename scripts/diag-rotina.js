#!/usr/bin/env node
/**
 * scripts/diag-rotina.js
 *
 * CONFERÊNCIA da aba Rotina contra o painel da EDP ("Gestão de equipes - ES",
 * visual "Serviços e Desvios" → Exportar dados → .xlsx).
 *
 * Pedido do José em 15/10/2026: "vamos trabalhar na exatidão das informações
 * dessa aba". A régua é o export da EDP — é o número que a EDP vê. Este script
 * monta a rotina da equipe EXATAMENTE como a tela (db/rotinaQueries.rotinaEquipe)
 * e casa evento a evento com o export:
 *
 *   Desvio        casado pelo código do motivo ("06", "15", "29"...)
 *   Deslocamento  casado pelo número da nota
 *   Serviço       casado pelo número da nota (as linhas "Serviço - Atividade"
 *                 do export são as atividades DENTRO do serviço — ignoradas)
 *
 * Para cada par: diferença de início e de fim em SEGUNDOS. O que sobra de um
 * lado ou de outro sai listado — é ali que mora o erro.
 *
 * ESTRITAMENTE READ-ONLY: só SELECTs (os mesmos da tela). Se o dia for HOJE, a
 * tela busca as paradas ao vivo (1 GET por sessão em sessions/{id}/break) — o
 * script faz o mesmo. Rodar na VM:
 *
 *   cd ~/prod-stc && node scripts/diag-rotina.js EPICO30 2026-09-04 "Serviços e Desvios.xlsx"
 *   cd ~/prod-stc && node scripts/diag-rotina.js EPICO30 2026-09-04          # só lista o nosso
 */

'use strict';

const path = require('path');

const TOL_CASAMENTO_MIN = 30;   // início a mais de 30 min de distância não é o mesmo evento

/** "06 - Check List" → "06". Sem código, o texto todo em minúsculas. */
function chaveMotivo(m) {
  const s = String(m || '').trim();
  const c = s.match(/^(\d{1,3})\s*-/);
  return c ? String(Number(c[1])) : s.toLowerCase();
}

const _p2 = n => String(n).padStart(2, '0');
function hhmmss(min) {
  if (min == null) return '—';
  const t = Math.round(min * 60);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${_p2(h % 24)}:${_p2(m)}:${_p2(s)}${h >= 24 ? '(+1)' : ''}`;
}

/**
 * FUNÇÃO PURA (testável): célula de data do export → minutos desde a
 * meia-noite de `dia` (parede BRT). Aceita serial do Excel ou texto nos dois
 * formatos que o Power BI usa ("9/4/2026 11:00:20 AM" e "04/09/2026 11:00:20").
 * O serial do Excel é PAREDE (sem fuso) — lido como UTC só para fazer conta.
 */
function minutosDoExport(v, dia) {
  if (v == null || v === '') return null;
  const base = Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10));
  if (typeof v === 'number' && Number.isFinite(v)) {
    const seg = Math.round((v - 25569) * 86400);      // serial tem ruído de float
    return (seg * 1000 - base) / 60000;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  let y, mo, d, h, mi, se;
  if (m) {                                   // M/D/YYYY h:mm:ss AM (en-US)
    [mo, d, y, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
    if (/pm/i.test(m[7]) && h < 12) h += 12;
    if (/am/i.test(m[7]) && h === 12) h = 0;
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) {
    [d, mo, y, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];   // DD/MM/YYYY (pt-BR)
  } else {
    return null;
  }
  return (Date.UTC(y, mo - 1, d, h, mi, se) - base) / 60000;
}

/** FUNÇÃO PURA: linhas do export (objetos por cabeçalho) → eventos comparáveis. */
function eventosDoExport(linhas, team, dia) {
  const out = [];
  for (const l of linhas) {
    if (team && String(l.Equipe || '').trim().toUpperCase() !== team) continue;
    const evento = String(l.Evento || '').trim();
    if (!['Desvio', 'Deslocamento', 'Serviço'].includes(evento)) continue;   // "Serviço - Atividade" fora
    out.push({
      evento,
      chave: evento === 'Desvio' ? chaveMotivo(l['Descrição']) : String(l.Nota || '').trim(),
      descricao: String(l['Descrição'] || '').trim(),
      ini: minutosDoExport(l['Início'], dia),
      fim: minutosDoExport(l.Fim, dia),
    });
  }
  return out.filter(e => e.ini != null).sort((a, b) => a.ini - b.ini);
}

/** FUNÇÃO PURA: faixas da rotina (minutos) → eventos comparáveis. */
function eventosDaRotina(rotina) {
  const f = (rotina && rotina.faixas) || {};
  const nota = i => [i.tipo, i.numero].filter(Boolean).join(' - ');
  return [
    ...(f.desvio || []).map(i => ({ evento: 'Desvio', chave: chaveMotivo(i.motivo), descricao: i.motivo || '', ini: i.ini, fim: i.aberto ? null : i.fim })),
    ...(f.deslocamento || []).map(i => ({ evento: 'Deslocamento', chave: String(i.numero || ''), descricao: nota(i), ini: i.ini, fim: i.fim })),
    ...(f.servico || []).map(i => ({ evento: 'Serviço', chave: String(i.numero || ''), descricao: `${nota(i)} - ${i.status}`, ini: i.ini, fim: i.aberto ? null : i.fim })),
  ].sort((a, b) => a.ini - b.ini);
}

/**
 * FUNÇÃO PURA (testável): casa EDP × nosso. Mesmo evento e mesma chave, o de
 * início mais próximo dentro da tolerância; cada lado usado uma vez só.
 */
function casar(edp, nosso, tolMin = TOL_CASAMENTO_MIN) {
  const livres = nosso.map((e, i) => ({ ...e, _i: i }));
  const usados = new Set();
  const pares = [], soEdp = [];
  for (const e of edp) {
    let melhor = null;
    for (const n of livres) {
      if (usados.has(n._i) || n.evento !== e.evento || n.chave !== e.chave) continue;
      const d = Math.abs(n.ini - e.ini);
      if (d <= tolMin && (!melhor || d < Math.abs(melhor.ini - e.ini))) melhor = n;
    }
    if (!melhor) { soEdp.push(e); continue; }
    usados.add(melhor._i);
    const seg = (a, b) => (a == null || b == null ? null : Math.round((b - a) * 60));
    pares.push({ edp: e, nosso: melhor, dIniSeg: seg(e.ini, melhor.ini), dFimSeg: seg(e.fim, melhor.fim) });
  }
  const soNosso = livres.filter(n => !usados.has(n._i));
  return { pares, soEdp, soNosso };
}

function _lerExport(arquivo) {
  const XLSX = require(path.join(__dirname, '..', 'public', 'vendor', 'xlsx.full.min.js'));
  const wb = XLSX.read(require('fs').readFileSync(arquivo), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // raw: data vem como serial do Excel (parede), sem o Date do driver no meio.
  return XLSX.utils.sheet_to_json(ws, { raw: true, defval: null });
}

async function main() {
  require('dotenv').config({ override: true });
  const [teamArg, dia, arquivo] = process.argv.slice(2);
  if (!teamArg || !/^\d{4}-\d{2}-\d{2}$/.test(dia || '')) {
    console.error('uso: node scripts/diag-rotina.js EQUIPE YYYY-MM-DD [export.xlsx]');
    process.exit(2);
  }
  const team = teamArg.trim().toUpperCase();
  const { rotinaEquipe } = require('../db/rotinaQueries');
  const r = await rotinaEquipe(team, dia);
  if (!r) { console.error('sem conexão com o Postgres (DATABASE_URL).'); process.exit(1); }

  const t = r.totaisMin || {};
  console.log(`\n${team} · ${dia}`);
  console.log(`  escala ${t.escala} min · sessão ${t.sessao} min · desvio ${t.desvio} · deslocamento ${t.deslocamento} · serviço ${t.servico}`);
  for (const s of (r.faixas?.sessao || [])) console.log(`  sessão ${hhmmss(s.ini)} → ${hhmmss(s.fim)}${s.aberta ? ' (aberta)' : ''}`);
  for (const e of (r.faixas?.escala || [])) console.log(`  escala ${e.codigo || ''} ${hhmmss(e.ini)} → ${hhmmss(e.fim)}`);
  if ((r.erros || []).length) console.log(`  ⚠ fontes com erro: ${r.erros.join(' | ')}`);
  console.log(`  avisos: ${JSON.stringify(r.avisos)}`);

  const nosso = eventosDaRotina(r);
  if (!arquivo) {
    console.log('\nEVENTOS (painel):');
    for (const e of nosso) console.log(`  ${e.evento.padEnd(12)} ${hhmmss(e.ini)} → ${hhmmss(e.fim)}  ${e.descricao}`);
    return;
  }

  const edp = eventosDoExport(_lerExport(arquivo), team, dia);
  const { pares, soEdp, soNosso } = casar(edp, nosso);
  const ok = p => Math.abs(p.dIniSeg ?? 0) <= 60 && Math.abs(p.dFimSeg ?? 0) <= 60;

  console.log(`\nCASADOS (${pares.length}) — Δ em segundos, painel − EDP:`);
  for (const p of pares) {
    console.log(`  ${ok(p) ? '✓' : '✗'} ${p.edp.evento.padEnd(12)} ${p.edp.descricao.slice(0, 40).padEnd(40)} ` +
      `ini ${hhmmss(p.edp.ini)} Δ${p.dIniSeg ?? '—'}s · fim ${hhmmss(p.edp.fim)} Δ${p.dFimSeg ?? '—'}s`);
  }
  console.log(`\nSÓ NA EDP (${soEdp.length}) — o painel não mostra:`);
  for (const e of soEdp) console.log(`  ${e.evento.padEnd(12)} ${hhmmss(e.ini)} → ${hhmmss(e.fim)}  ${e.descricao}`);
  console.log(`\nSÓ NO PAINEL (${soNosso.length}) — a EDP não mostra:`);
  for (const e of soNosso) console.log(`  ${e.evento.padEnd(12)} ${hhmmss(e.ini)} → ${hhmmss(e.fim)}  ${e.descricao}`);
  const fora = pares.filter(p => !ok(p)).length;
  console.log(`\nRESUMO: ${pares.length - fora} batem (≤60s), ${fora} com diferença, ${soEdp.length} faltando, ${soNosso.length} sobrando.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { chaveMotivo, minutosDoExport, eventosDoExport, eventosDaRotina, casar };
