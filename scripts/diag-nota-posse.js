/**
 * Diagnóstico da POSSE de uma nota (P1-23, passos 1 e 2).
 *
 * `GET /api/Notes/{id}/historic` devolve a janela em que cada equipe deteve a
 * nota. Hoje a atribuição "de quem é essa produção" é INFERIDA por dia de sessão
 * (com as armadilhas dos P1-14/P1-15/P1-16); com `historic` ela passa a ser
 * consulta. Este script mostra as duas lado a lado — a janela da EDP e o que nós
 * gravamos — para permitir a medição que o item exige ANTES de mexer em número.
 *
 * ⚠️ Não muda nada. É read-only, como todo `diag-*`. E gasta 1 requisição por
 * nota na conta compartilhada (P1-25), então passe poucas notas por vez.
 *
 * As duas notas já validadas no portal, citadas no P1-23, são um bom começo:
 *   node -r dotenv/config scripts/diag-nota-posse.js 030009946354 030009957459
 *
 * Uso: node -r dotenv/config scripts/diag-nota-posse.js <numero|uuid> [...]
 */

require('dotenv').config();
process.env.DATA_MODE = 'wpa';

const { getClient } = require('../services/dbClient');
const { getNoteHistoric, searchNoteByNumber } = require('../services/wpaService');

const ARGS = process.argv.slice(2);
if (ARGS.length === 0) {
  console.error('Uso: node -r dotenv/config scripts/diag-nota-posse.js <numero|uuid> [...]');
  process.exit(1);
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

(async () => {
  const sb = getClient();

  for (const arg of ARGS) {
    console.log(`\n${'='.repeat(64)}\nnota: ${arg}`);

    // Número humano → UUID. Usa o endpoint de busca (P2-34) em vez de varrer o
    // banco, porque nota de auditoria costuma não ser do dia corrente.
    let noteId = arg;
    if (!RE_UUID.test(arg)) {
      try {
        const achada = await searchNoteByNumber(arg);
        if (!achada?.id) { console.log('  não encontrada na WPA por número — pulando'); continue; }
        noteId = achada.id;
        console.log(`  número → uuid: ${noteId}   (equipe atual na WPA: ${achada.equipe || '?'})`);
      } catch (e) {
        console.log(`  falha resolvendo o número: ${e.message}`);
        continue;
      }
    }

    // 1) A verdade da EDP: janelas de posse.
    let janelas;
    try {
      janelas = await getNoteHistoric(noteId);
    } catch (e) {
      console.log(`  historic falhou: ${e.message}`);
      continue;
    }

    console.log('\n  ── POSSE SEGUNDO A EDP (Notes/{id}/historic) ──');
    if (janelas.length === 0) {
      console.log('  (nenhuma janela devolvida)');
    } else {
      for (const j of janelas) {
        console.log(`  ${String(j.equipe).padEnd(12)} de ${j.de || '?'} até ${j.ate || 'AGORA (posse vigente)'}`);
      }
    }

    // 2) O que NÓS gravamos, para comparar.
    if (!sb) { console.log('\n  (sem banco: não deu pra comparar com a nossa atribuição)'); continue; }

    const { data: rej } = await sb
      .from('note_rejections')
      .select('team_name, rejection_date, session_date, motivo_codes')
      .eq('note_id', noteId);

    console.log('\n  ── O QUE NÓS GRAVAMOS ──');
    if (!rej || rej.length === 0) {
      console.log('  nada em note_rejections');
    } else {
      for (const r of rej) {
        console.log(`  rejeitada por ${String(r.team_name).padEnd(12)} ` +
          `rejection_date=${r.rejection_date} session_date=${r.session_date} ` +
          `codes=${JSON.stringify(r.motivo_codes)}`);
      }
    }

    console.log('\n  Leitura: a equipe que nós atribuímos deveria cair DENTRO da janela');
    console.log('  de posse dela. Divergência aqui é o que o P1-23 pede pra medir —');
    console.log('  e o item é explícito: medir, validar no portal e revisar ANTES de');
    console.log('  trocar a fonte de verdade, porque isso é número reportado à EDP.');
  }

  console.log('');
})().catch(err => { console.error(err); process.exit(1); });
