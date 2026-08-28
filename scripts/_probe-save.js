/* Smoke test temporário — persistir snapshot de notas devolvidas.
 *
 * ⚠️⚠️ ESTE SCRIPT GRAVA EM PRODUÇÃO. ⚠️⚠️
 *
 * 28/08/2026 (auditoria P2-43): eram 12 linhas sem dry-run, sem confirmação e sem
 * argumento — bastava `node scripts/_probe-save.js` e um snapshot entrava na
 * tabela `notas_snapshots` de produção. O prefixo `_` sugere que era descartável;
 * ficou commitado desde então.
 *
 * A auditoria recomendou APAGAR (o `git log` guarda, se voltar a fazer falta), mas
 * deletar arquivo é decisão do dono do repo — então por ora entrou a guarda
 * abaixo. Se você é o dono e concorda em apagar, apague; se este script tem uso
 * real, troque este comentário pela explicação do uso e tire o "temporário" do
 * título.
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
