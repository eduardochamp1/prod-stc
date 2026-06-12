/**
 * Diagnóstico: simular o filtro notaPertenceAoRange do frontend pra entender
 * por que muitas notas estão sendo descartadas.
 *
 * Uso: node scripts/diag-conclusion-dates.js <DE> <ATE>
 */

require('dotenv').config();
const { getTeamsByDateFromSnapshots } = require('../db/supabaseQueries');

const DE  = process.argv[2];
const ATE = process.argv[3];
if (!DE || !ATE) {
  console.error('Uso: node scripts/diag-conclusion-dates.js <DE> <ATE>');
  process.exit(1);
}

function notaPertenceAoRange(n, de, ate) {
  if (!n.conclusionDate) {
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    return de <= hoje && hoje <= ate;
  }
  const cd = String(n.conclusionDate).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(cd)) return cd >= de && cd <= ate;
  const m = n.conclusionDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    return iso >= de && iso <= ate;
  }
  return false;
}

(async () => {
  const teams = await getTeamsByDateFromSnapshots(DE, ATE, ['GUA', 'CAC', 'SJC']);
  console.log(`Equipes: ${teams.length}\n`);

  // Coleta TODAS as notas (concluidas + executadas)
  let total = 0, semConcDate = 0, dentro = 0, fora = 0;
  const porData = {};
  const exemploSemDate = [];
  const exemploFora = [];

  teams.forEach(t => {
    const realizadas = [...(t.notasConcluidas || []), ...(t.notasExecutadas || [])];
    realizadas.forEach(n => {
      total++;
      if (!n.conclusionDate) {
        semConcDate++;
        if (exemploSemDate.length < 3) exemploSemDate.push({ team: t.teamName, n });
        return;
      }
      const cd = String(n.conclusionDate).slice(0, 10);
      porData[cd] = (porData[cd] || 0) + 1;
      if (notaPertenceAoRange(n, DE, ATE)) dentro++;
      else {
        fora++;
        if (exemploFora.length < 5) exemploFora.push({ team: t.teamName, n });
      }
    });
  });

  console.log(`=== TOTAL: ${total} notas ===`);
  console.log(`Dentro do range (${DE} → ${ATE}): ${dentro}`);
  console.log(`Fora do range:                    ${fora}`);
  console.log(`Sem conclusionDate:               ${semConcDate}`);
  console.log();

  console.log('=== Distribuição por mês (conclusionDate) ===');
  const porMes = {};
  Object.entries(porData).forEach(([d, c]) => {
    const mes = d.slice(0, 7);
    porMes[mes] = (porMes[mes] || 0) + c;
  });
  Object.entries(porMes).sort().forEach(([m, c]) => console.log(`  ${m}: ${c}`));

  console.log('\n=== Exemplos sem conclusionDate ===');
  exemploSemDate.forEach(e => console.log(JSON.stringify(e)));

  console.log('\n=== Exemplos FORA do range ===');
  exemploFora.forEach(e => console.log(JSON.stringify(e)));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
