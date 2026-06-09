/* Smoke test temporário — remover após validar Task 2. */
require('dotenv').config();
const { getNotasDevolvidas } = require('../services/wpaService');

(async () => {
  const notas = await getNotasDevolvidas();
  console.log('total:', notas.length);
  if (notas.length === 0) {
    console.log('⚠ resposta vazia — pode ser que precise payload no body do POST');
    process.exit(2);
  }
  const primeira = notas[0];
  console.log('primeira nota:', {
    Number: primeira.Number,
    Type: primeira.Type,
    'Team.Name': primeira.Team?.Name,
    Status: primeira.Status,
    ConclusionDate: primeira.ConclusionDate,
    ConclusionStatus: primeira.ConclusionStatus,
    Id: primeira.Id,
  });
  const equipes = [...new Set(notas.map(n => n.Team?.Name).filter(Boolean))].sort();
  console.log('equipes únicas:', equipes.length);
  console.log('primeiras 15 equipes:', equipes.slice(0, 15));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
