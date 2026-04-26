/**
 * db/queries.js
 * CRUD SQLite — metas, snapshots e totais diários.
 */

const { getDb } = require('./index');

// ── METAS ─────────────────────────────────────────────────────────────────────

/** Retorna { GUA: { LN: 50, RL: 200 }, CAC: { LN: 30 } } */
function getMetas() {
  const rows = getDb()
    .prepare(`SELECT regional, tipo_code, valor FROM metas ORDER BY regional, tipo_code`)
    .all();

  const obj = { GUA: {}, CAC: {} };
  rows.forEach(r => {
    if (!obj[r.regional]) obj[r.regional] = {};
    obj[r.regional][r.tipo_code] = r.valor;
  });
  return Promise.resolve(obj);
}

/** Salva metas completas — obj: { GUA: { LN: 50 }, CAC: { RL: 100 } } */
function setMetas(obj) {
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO metas (regional, tipo_code, valor, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (regional, tipo_code)
    DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at
  `);

  const deleteOutdated = db.prepare(`
    DELETE FROM metas
    WHERE regional = ?
      AND tipo_code NOT IN (SELECT value FROM json_each(?))
  `);

  const deleteAll = db.prepare(`DELETE FROM metas WHERE regional = ?`);

  db.transaction(() => {
    for (const regional of Object.keys(obj)) {
      const tipos = Object.keys(obj[regional]);
      for (const [tipo_code, valor] of Object.entries(obj[regional])) {
        upsert.run(regional, tipo_code, valor);
      }
      if (tipos.length > 0) {
        deleteOutdated.run(regional, JSON.stringify(tipos));
      } else {
        deleteAll.run(regional);
      }
    }
  })();

  return Promise.resolve();
}

// ── SNAPSHOTS ─────────────────────────────────────────────────────────────────

/** Salva snapshot de uma lista de equipes */
function saveSnapshot(teams) {
  const db   = getDb();
  const date = new Date().toISOString().slice(0, 10);

  const insert = db.prepare(`
    INSERT INTO snapshots
      (captured_at, date, team_name, sector_id, regional,
       session_begin, session_end, vehicle_plate,
       baixadas, executadas, concluidas, rejeitadas,
       collaborators, notas_concluidas)
    VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const t of teams) {
      insert.run(
        date,
        t.teamName || t.sigla,
        t.sectorId,
        t.regional,
        t.sessionBegin || null,
        t.sessionEnd   || null,
        t.vehiclePlate || null,
        (t.notasBaixadas   || []).length,
        (t.notasExecutadas || []).length,
        (t.notasConcluidas || []).length,
        (t.notasRejeitadas || []).length,
        JSON.stringify(t.collaborators   || []),
        JSON.stringify(t.notasConcluidas || []),
      );
    }
  })();

  return Promise.resolve();
}

// ── DAILY TOTALS ──────────────────────────────────────────────────────────────

/** Consolida snapshots do dia em daily_totals (pega o mais recente por equipe) */
function consolidateDay(date) {
  const db = getDb();

  const rows = db.prepare(`
    SELECT s.team_name, s.sector_id, s.regional,
           s.baixadas, s.executadas, s.concluidas, s.rejeitadas,
           s.notas_concluidas
    FROM snapshots s
    INNER JOIN (
      SELECT team_name, MAX(captured_at) AS max_cap
      FROM snapshots WHERE date = ?
      GROUP BY team_name
    ) latest ON s.team_name = latest.team_name
            AND s.captured_at = latest.max_cap
    WHERE s.date = ?
  `).all(date, date);

  const upsert = db.prepare(`
    INSERT INTO daily_totals
      (date, team_name, sector_id, regional,
       baixadas, executadas, concluidas, rejeitadas, tipos_concluidos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (date, team_name) DO UPDATE SET
      baixadas         = excluded.baixadas,
      executadas       = excluded.executadas,
      concluidas       = excluded.concluidas,
      rejeitadas       = excluded.rejeitadas,
      tipos_concluidos = excluded.tipos_concluidos
  `);

  db.transaction(() => {
    for (const r of rows) {
      const tiposConcluidos = {};
      let notas = [];
      try { notas = JSON.parse(r.notas_concluidas || '[]'); } catch {}
      notas.forEach(n => {
        const code = n.tipoCode || n.tipo_code;
        if (code) tiposConcluidos[code] = (tiposConcluidos[code] || 0) + 1;
      });

      upsert.run(
        date, r.team_name, r.sector_id, r.regional,
        r.baixadas, r.executadas, r.concluidas, r.rejeitadas,
        JSON.stringify(tiposConcluidos),
      );
    }
  })();

  console.log(`[DB] daily_totals consolidado para ${date} — ${rows.length} equipes`);
  return Promise.resolve();
}

/** Totais mensais por regional/tipo → { GUA: { LN: 120 }, CAC: { RL: 80 } } */
function getMonthTotals(yearMonth) {
  const rows = getDb().prepare(`
    SELECT regional, tipos_concluidos
    FROM daily_totals
    WHERE strftime('%Y-%m', date) = ?
  `).all(yearMonth);

  const totais = { GUA: {}, CAC: {} };
  rows.forEach(r => {
    const reg = r.regional;
    if (!totais[reg]) totais[reg] = {};
    let tipos = {};
    try { tipos = JSON.parse(r.tipos_concluidos || '{}'); } catch {}
    Object.entries(tipos).forEach(([code, val]) => {
      totais[reg][code] = (totais[reg][code] || 0) + Number(val);
    });
  });
  return Promise.resolve(totais);
}

/** Histórico dia a dia de um mês para gráfico */
function getDailyHistory(yearMonth) {
  const rows = getDb().prepare(`
    SELECT date, regional,
           SUM(concluidas) AS concluidas,
           SUM(baixadas)   AS baixadas,
           SUM(rejeitadas) AS rejeitadas
    FROM daily_totals
    WHERE strftime('%Y-%m', date) = ?
    GROUP BY date, regional
    ORDER BY date, regional
  `).all(yearMonth);

  return Promise.resolve(rows);
}

module.exports = { getMetas, setMetas, saveSnapshot, consolidateDay, getMonthTotals, getDailyHistory };
