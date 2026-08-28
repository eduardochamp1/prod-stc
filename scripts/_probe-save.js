/* Smoke test do pipeline de notas devolvidas — GRAVA em produção.
 *
 * ⚠️⚠️ ESTE SCRIPT GRAVA EM PRODUÇÃO. ⚠️⚠️
 *
 * 28/08/2026 (auditoria P2-43): eram 12 linhas sem dry-run, sem confirmação e sem
 * argumento — bastava `node scripts/_probe-save.js` e um snapshot entrava na
 * tabela `notas_snapshots` de produção. O prefixo `_` sugere que era descartável;
 * ficou commitado desde então.
 *
 * A auditoria recomendou APAGAR. **Decisão de 28/08/2026: MANTER**, com a guarda
 * abaixo. Então ele não é mais "temporário" — é uma ferramenta de smoke test do
 * pipeline de notas devolvidas, que grava de verdade e por isso exige a flag.
 *
 * O que ele faz: coleta as notas devolvidas dos setores via WPA, filtra as da
 * Engelmig pelo CompanyId e INSERE um snapshot em `notas_snapshots` com o
 * timestamp do momento. Serve pra validar ponta a ponta que
 * getTeamsSimple + getNotasDevolvidas + filterEngelmig + saveSnapshot estão
 * funcionando — o mesmo caminho que o cron das :05 usa.
 *
 * ⚠️ Cada execução grava uma linha por nota devolvida. Não rode "pra ver o que
 * acontece": o dado entra no histórico e o monitor de notas devolvidas passa a
 * contar aquele instante como uma coleta real.
 */

require('dotenv').config();

const FLAG = '--eu-sei-que-isto-grava-em-producao';
if (!process.argv.includes(FLAG)) {
  console.error('scripts/_probe-save.js GRAVA UM SNAPSHOT EM PRODUÇÃO.');
  console.error('');
  console.error('Ele coleta as notas devolvidas da EDP e as INSERE em notas_snapshots.');
  console.error('Não tem dry-run e não pergunta nada — por isso a flag.');
  console.error('');
  console.error(`Rode com ${FLAG} se é isso mesmo.`);
  process.exit(1);
}

const { getNotasDevolvidas, getTeamsSimple } = require('../services/wpaService');
const { filterEngelmig, buildTeamCompanyMap, saveSnapshot } = require('../services/notasMonitor');

(async () => {
  const [teams, notas] = await Promise.all([getTeamsSimple(), getNotasDevolvidas()]);
  const eng = filterEngelmig(notas, buildTeamCompanyMap(teams));
  const ts  = new Date().toISOString();
  const n   = await saveSnapshot(eng, ts);
  console.log('inseridos:', n, 'em ts:', ts);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
