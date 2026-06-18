#!/usr/bin/env node
/**
 * scripts/diag-audit2.js
 * AUDITORIA FASE 2 — fidelidade dos campos que o site exibe vs WPA.
 *
 * Complementa scripts/diag-audit.js (classificação + drift). Aqui cobrimos:
 *   1. COBERTURA DA WHITELIST — equipes Engelmig operando na WPA mas fora de
 *      equipes_oficiais (o site as ESCONDE → subnotificação) + oficiais sem
 *      atividade recente (cadastro morto). [parte ao vivo na WPA + parte DB]
 *   2. REJEIÇÕES — note_rejections está completa? % com motivo preenchido?
 *      snapshot tem rejeitada que a tabela não tem? [DB]
 *   3. DATAS / FUSO — conclusões no futuro ou sem marcador de timezone (a
 *      classe de bug do WPA que adianta horários em 3h). [DB]
 *   4. INVARIANTE DE KPI DO DIA — a aritmética do _buildDiaSummary fecha? [DB]
 *
 * Read-only. A seção 1 faz ~4 GETs leves à WPA (sessions/all/date por setor);
 * só roda se DATA_MODE=wpa. As demais são só SELECT no Postgres.
 *
 * Uso (na VM): node scripts/diag-audit2.js
 */

require('dotenv').config({ override: true });

const { dateBRT, dateBRTMinusDays } = require('../services/timeUtil');
const MODE = (process.env.DATA_MODE || 'mock').toLowerCase();

let pool;
try {
  pool = require('../services/pgShim')._getPool();
} catch (err) {
  console.error('\n[diag-audit2] sem pool Postgres:', err.message);
  console.error('[diag-audit2] exige DATABASE_URL no .env.\n');
  process.exit(1);
}

const H    = (s) => console.log(`\n${'═'.repeat(70)}\n  ${s}\n${'═'.repeat(70)}`);
const ok   = (s) => console.log(`  ✅ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const bad  = (s) => console.log(`  🔴 ${s}`);
const info = (s) => console.log(`     ${s}`);
const pct  = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0') + '%';

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }
async function section(title, fn) {
  H(title);
  try { await fn(); } catch (err) { bad(`falhou: ${err.message}`); }
}

async function main() {
  const hoje = dateBRT();
  H(`AUDITORIA FASE 2 — FIDELIDADE DE CAMPOS  ${hoje} (BRT)`);

  // ── 1. COBERTURA DA WHITELIST ─────────────────────────────────────────────
  await section('1. COBERTURA DA WHITELIST (equipes invisíveis / cadastro morto)', async () => {
    const wl = await q(`SELECT upper(sigla) AS sigla FROM equipes_oficiais WHERE ativo = true`);
    const wlSet = new Set(wl.map(r => r.sigla));
    info(`whitelist ativa: ${wlSet.size} equipes`);

    // 1a. Equipes Engelmig operando HOJE na WPA mas fora da whitelist.
    if (MODE === 'wpa') {
      const ENGELMIG = process.env.WPA_COMPANY_ID || '92a2f98e-8877-433e-8358-173b94c13a54';
      const SECTORS  = ['DESG', 'DEPT', 'DESC', 'DSSJ'];
      const { getSessionsByDate } = require('../services/wpaService');
      const operando = new Set();
      for (const sec of SECTORS) {
        try {
          const sess = await getSessionsByDate(sec, hoje);
          sess.filter(s => s.Team?.CompanyId === ENGELMIG).forEach(s => {
            const sigla = (s.Team?.Name || '').trim().toUpperCase();
            if (sigla) operando.add(sigla);
          });
        } catch (e) { warn(`setor ${sec}: ${e.message}`); }
      }
      info(`equipes Engelmig operando hoje (todos os setores): ${operando.size}`);
      const fora = [...operando].filter(s => !wlSet.has(s)).sort();
      // Tipos de CAMPO (EB/EC/EP/ET) fora da whitelist = forte suspeita de
      // subnotificação. Demais prefixos (EU/EE/EM/EN/EV…) costumam ser
      // backoffice/agregados intencionalmente fora.
      const campo  = fora.filter(s => /^(EB|EC|EP|ET)/.test(s));
      const outras = fora.filter(s => !/^(EB|EC|EP|ET)/.test(s));
      if (fora.length === 0) ok('Toda equipe operando hoje está na whitelist.');
      else {
        if (campo.length > 0) {
          bad(`${campo.length} equipe(s) de CAMPO operando FORA da whitelist (site não mostra → subnotifica):`);
          info(campo.join(', '));
        } else ok('Nenhuma equipe de campo (EB/EC/EP/ET) fora da whitelist.');
        if (outras.length > 0) {
          warn(`${outras.length} outra(s) fora da whitelist (provável backoffice/agregado — revisar se alguma é de campo):`);
          info(outras.join(', '));
        }
      }
    } else {
      warn(`DATA_MODE=${MODE} — checagem ao vivo pulada (precisa DATA_MODE=wpa).`);
    }

    // 1b. Oficiais ATIVAS sem nenhum snapshot nos últimos 14 dias (cadastro morto?).
    const stale = await q(
      `SELECT eo.sigla, eo.regional FROM equipes_oficiais eo
       WHERE eo.ativo = true
         AND NOT EXISTS (
           SELECT 1 FROM snapshots s
           WHERE upper(s.team_name) = upper(eo.sigla) AND s.date >= $1)
       ORDER BY eo.regional, eo.sigla`, [dateBRTMinusDays(14)]);
    if (stale.length === 0) ok('Toda equipe oficial ativa teve snapshot nos últimos 14 dias.');
    else {
      warn(`${stale.length} oficial(is) ativa(s) SEM snapshot em 14 dias (cadastro morto ou de férias?):`);
      info(stale.slice(0, 30).map(r => `${r.sigla}(${r.regional})`).join(', '));
      if (stale.length > 30) info(`… +${stale.length - 30}`);
    }
  });

  // ── 2. REJEIÇÕES ──────────────────────────────────────────────────────────
  await section('2. REJEIÇÕES (completude e cobertura de motivos)', async () => {
    const d7 = dateBRTMinusDays(7);
    const r = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE array_length(motivo_codes,1) > 0)::int AS com_motivo,
              max(fetched_at) AS ultimo_fetch
       FROM note_rejections WHERE session_date >= $1`, [d7]);
    const { total, com_motivo, ultimo_fetch } = r[0];
    info(`últimos 7 dias: ${total} rejeições  |  com motivo: ${com_motivo} (${pct(com_motivo, total)})`);
    if (total > 0 && com_motivo / total < 0.4)
      warn(`menos de 40% têm motivo — muitas "Sem motivo registrado" no site (esperado p/ bandeiradas tipo Conta Paga, mas vale conferir).`);
    const lag = ultimo_fetch ? Math.round((Date.now() - new Date(ultimo_fetch)) / 60000) : null;
    if (lag == null) bad('nenhum fetch de rejeição nos últimos 7 dias — cron parado?');
    else if (lag > 180) warn(`último fetch de rejeição há ${lag} min (>3h) — cron pode estar atrasado.`);
    else ok(`cron de rejeições ativo (último fetch há ${lag} min).`);

    // Coerência: rejeitadas no último snapshot de hoje que NÃO estão na tabela.
    // note_rejections é a fonte autoritativa (WPA limpa do payload), então
    // snap-sem-tabela = o cron de detalhe de rejeição ainda não capturou.
    const coer = await q(
      `WITH ls AS (
         SELECT DISTINCT ON (team_name) team_name, data
         FROM snapshots WHERE date = $1 ORDER BY team_name, captured_at DESC),
       sr AS (
         SELECT DISTINCT (n->>'id') AS note_id
         FROM ls, jsonb_array_elements(COALESCE(data->'notasRejeitadas','[]'::jsonb)) n
         WHERE n->>'id' IS NOT NULL)
       SELECT
         (SELECT count(*) FROM sr)::int AS snap_rej,
         (SELECT count(*) FROM note_rejections WHERE session_date = $1)::int AS tabela_rej,
         (SELECT count(*) FROM sr WHERE NOT EXISTS (
            SELECT 1 FROM note_rejections nr
            WHERE nr.note_id::text = sr.note_id))::int AS snap_fora_tabela`, [hoje]);
    const { snap_rej, tabela_rej, snap_fora_tabela } = coer[0];
    info(`hoje: snapshot tem ${snap_rej} rejeitadas | tabela note_rejections ${tabela_rej}`);
    if (snap_fora_tabela > 0)
      warn(`${snap_fora_tabela} rejeitada(s) no snapshot de hoje ainda não estão em note_rejections (cron pode capturar no próximo ciclo).`);
    else ok('Toda rejeitada do snapshot de hoje já está em note_rejections.');
  });

  // ── 3. DATAS / FUSO HORÁRIO ───────────────────────────────────────────────
  await section('3. DATAS / FUSO (conclusões no futuro ou sem marcador TZ)', async () => {
    // Só payloads com conclusao em formato ISO.
    const base = await q(
      `SELECT count(*)::int AS n FROM note_details
       WHERE payload->'datas'->>'conclusao' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}'`);
    const totalIso = base[0].n;
    info(`note_details com conclusão ISO: ${totalIso}`);
    if (totalIso === 0) { warn('sem conclusões ISO em note_details — nada a checar.'); return; }

    // 3a. Sem marcador de TZ (Z ou ±HH:MM) → vulneráveis ao bug de +3h na exibição.
    const semTz = await q(
      `SELECT count(*)::int AS n FROM note_details
       WHERE payload->'datas'->>'conclusao' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}'
         AND payload->'datas'->>'conclusao' !~ '([Zz]|[+-]\\d{2}:?\\d{2})$'`);
    if (semTz[0].n === 0) ok('Todas as conclusões têm marcador de timezone (Z/offset).');
    else warn(`${semTz[0].n} conclusão(ões) SEM marcador TZ (${pct(semTz[0].n, totalIso)}) — caches antigos pré-fix de 08/06; exibição pode adiantar 3h. Re-cache resolveria.`);

    // 3b. Conclusões no FUTURO (cast só nas que têm Z/offset, pra não estourar).
    const fut = await q(
      `SELECT count(*)::int AS n FROM note_details
       WHERE payload->'datas'->>'conclusao' ~ '([Zz]|[+-]\\d{2}:?\\d{2})$'
         AND (payload->'datas'->>'conclusao')::timestamptz > now() + interval '2 hours'`);
    if (fut[0].n === 0) ok('Nenhuma conclusão datada no futuro.');
    else bad(`${fut[0].n} conclusão(ões) no FUTURO — bug de data/timezone, investigar.`);

    // 3c. Distribuição por hora BRT (últimos 30d) — campo trabalha ~06–20h.
    const hist = await q(
      `SELECT EXTRACT(hour FROM (payload->'datas'->>'conclusao')::timestamptz
                AT TIME ZONE 'America/Sao_Paulo')::int AS h, count(*)::int AS n
       FROM note_details
       WHERE payload->'datas'->>'conclusao' ~ '([Zz]|[+-]\\d{2}:?\\d{2})$'
         AND (payload->'datas'->>'conclusao')::timestamptz >= now() - interval '30 days'
       GROUP BY 1 ORDER BY 1`);
    if (hist.length > 0) {
      const totH = hist.reduce((s, r) => s + r.n, 0);
      const foraExp = hist.filter(r => r.h < 5 || r.h > 21).reduce((s, r) => s + r.n, 0);
      info(`distribuição de conclusões por hora BRT (30d, n=${totH}):`);
      info(hist.map(r => `${String(r.h).padStart(2, '0')}h:${r.n}`).join('  '));
      if (foraExp / totH > 0.15)
        warn(`${pct(foraExp, totH)} das conclusões fora de 05–21h BRT — possível resíduo de fuso (esperado <15%).`);
      else ok('Distribuição horária coerente com jornada de campo (maioria 05–21h).');
    }
  });

  // ── 4. INVARIANTE DE KPI DO DIA ───────────────────────────────────────────
  await section('4. INVARIANTE DE KPI DO DIA (_buildDiaSummary)', async () => {
    const ds = require('../services/dataService');
    if (typeof ds._buildDiaSummary !== 'function') { warn('_buildDiaSummary indisponível.'); return; }
    const s = await ds._buildDiaSummary();   // hoje, todas as equipes
    if (!s) { warn('summary do dia retornou null (sem snapshots de hoje ainda?).'); return; }
    info(`inicial=${s.inicial}  atual=${s.atual}  andamento=${s.andamento}  concluidas=${s.concluidas}  rejeitadas=${s.rejeitadas}  canceladas=${s.canceladas}  novas=${s.entradas_novas}`);
    // Invariante derivada: inicial + novas === atual + andamento + conc + rej + canc
    const lhs = s.inicial + s.entradas_novas;
    const rhs = s.atual + s.andamento + s.concluidas + s.rejeitadas + s.canceladas;
    if (lhs === rhs) ok(`Invariante fecha: inicial+novas (${lhs}) == atual+and+conc+rej+canc (${rhs}).`);
    else bad(`Invariante NÃO fecha: ${lhs} != ${rhs} (diff ${lhs - rhs}) — bug na contagem do summary.`);
  });

  H('FIM DA AUDITORIA FASE 2');
  console.log('  Cole esta saída de volta no chat pra interpretação.\n');
}

main()
  .catch(err => { console.error('\n[diag-audit2] erro fatal:', err.message); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch (_) {} });
