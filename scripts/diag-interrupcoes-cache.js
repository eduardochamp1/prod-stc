/**
 * Diagnóstico LOCAL das interrupções que já estão pagas (P1-24, passo 1).
 *
 * `Interruptions[]` vem no `details/optimized` que já cacheamos em `note_details`.
 * Este script NÃO toca a API da EDP: lê só o cache local, então custa zero
 * requisição na conta compartilhada (P1-25). É exatamente o passo 1 do P1-24:
 * "inspecionar Interruptions[] no note_details JÁ cacheado — consulta local,
 * custo zero, sem tocar na EDP".
 *
 * O que responde:
 *   1. de quantas notas cacheadas o campo vem preenchido (e de quais tipos);
 *   2. nas notas REJEITADAS, o que a interrupção diz × o motivo que o
 *      rejectionService gravou em note_rejections;
 *   3. se o texto da interrupção seria uma fonte utilizável de motivo.
 *
 * É read-only, como todo `diag-*`.
 *
 * Uso: node -r dotenv/config scripts/diag-interrupcoes-cache.js [limite]
 * Ex:  node -r dotenv/config scripts/diag-interrupcoes-cache.js 500
 */

require('dotenv').config();

const { getClient } = require('../services/dbClient');

const LIMITE = Number(process.argv[2]) || 300;

(async () => {
  const sb = getClient();
  if (!sb) { console.error('Sem DATABASE_URL — rode na VM, dentro de ~/prod-stc.'); process.exit(1); }

  const { data: detalhes, error } = await sb
    .from('note_details')
    .select('note_id, payload, fetched_at')
    .order('fetched_at', { ascending: false })
    .limit(LIMITE);

  if (error) { console.error('Falha lendo note_details:', error.message); process.exit(1); }
  if (!detalhes || detalhes.length === 0) { console.log('note_details vazia.'); return; }

  console.log(`\nAnalisando ${detalhes.length} nota(s) do cache (mais recentes primeiro).\n`);

  let comCampo = 0, semCampo = 0, comTexto = 0;
  const porTipo   = new Map();
  const exemplos  = [];
  const tentativas = new Map();

  for (const d of detalhes) {
    const p = d.payload || {};
    const tipo = p.Type || '??';
    const ints = Array.isArray(p.Interruptions) ? p.Interruptions : [];

    if (ints.length === 0) { semCampo++; continue; }

    comCampo++;
    porTipo.set(tipo, (porTipo.get(tipo) || 0) + 1);
    for (const i of ints) {
      const t = String(i && i.Try);
      tentativas.set(t, (tentativas.get(t) || 0) + 1);
      if (i && i.Notes) comTexto++;
    }
    if (exemplos.length < 8) {
      exemplos.push({ noteId: d.note_id, numero: p.Number, tipo, ints: ints.slice(0, 2) });
    }
  }

  console.log('── COBERTURA ──────────────────────────────────────────────');
  console.log(`com Interruptions[] : ${comCampo}`);
  console.log(`sem Interruptions[] : ${semCampo}`);
  console.log(`interrupções com texto (Notes): ${comTexto}`);
  console.log(`\npor tipo de nota: ${[...porTipo.entries()].map(([t, n]) => `${t}=${n}`).join(' ') || '—'}`);
  console.log(`valores de Try   : ${[...tentativas.entries()].map(([t, n]) => `${t}→${n}`).join(' ') || '—'}`);
  console.log('  (esperado: 0 em tudo — medição de 21/08/2026 deu 2.058/2.058 com Try=0)');

  console.log('\n── EXEMPLOS ───────────────────────────────────────────────');
  for (const e of exemplos) {
    console.log(`\nnota ${e.numero || e.noteId} (${e.tipo})`);
    for (const i of e.ints) {
      console.log(`  Date=${i.Date}  Try=${i.Try}  Notes=${JSON.stringify(i.Notes || null)}`);
    }
  }

  // Cruza com o motivo que o rejectionService conseguiu, nas que são rejeitadas.
  const ids = exemplos.map(e => e.noteId);
  if (ids.length > 0) {
    const { data: rej, error: e2 } = await sb
      .from('note_rejections')
      .select('note_id, motivo_codes, motivo_texto, rejection_date')
      .in('note_id', ids);
    if (e2) {
      console.log(`\n(não consegui cruzar com note_rejections: ${e2.message})`);
    } else {
      console.log('\n── CRUZAMENTO COM note_rejections ─────────────────────────');
      if (!rej || rej.length === 0) {
        console.log('nenhuma das notas de exemplo está em note_rejections');
      } else {
        for (const r of rej) {
          console.log(`${r.note_id}  codes=${JSON.stringify(r.motivo_codes)}  ` +
            `texto=${JSON.stringify(r.motivo_texto)}  data=${r.rejection_date}`);
        }
      }
    }
  }

  console.log('\nLeitura: se a coluna "com Interruptions[]" for alta E o texto trouxer');
  console.log('o motivo, o dado já está pago e daria pra poupar 1 request por nota');
  console.log('rejeitada. Trocar a FONTE do motivo mexe na aba Rejeições — o P1-24');
  console.log('exige medir antes, e esta medição é o insumo dessa decisão.\n');
})().catch(err => { console.error(err); process.exit(1); });
