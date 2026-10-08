#!/usr/bin/env node
/**
 * scripts/probe-ssx.js
 * SONDA READ-ONLY da API do rastreador veicular SystemSatX (SSX).
 *
 * Uso (na VM):
 *   cd ~/prod-stc && node scripts/probe-ssx.js [PLACA] [--credenciais CAMINHO]
 *
 *   PLACA        placa Mercosul sem hífen (padrão: TIO2G36, ECASJ84/SJC)
 *   --credenciais lê as credenciais de outro .env (ex.: o do GSEQ, que usa
 *                 TRACKING_USERNAME/PASSWORD/HASH_AUTH) — assim a senha não
 *                 precisa ser copiada para o .env do WPA Monitor só pra sondar.
 *                 O nome NÃO pode ser --env-file: o Node >= 20 captura essa
 *                 opção mesmo depois do nome do script (08/10/2026, na VM:
 *                 "node: CAMINHO_DO_GSEQ/.env: not found").
 *
 * Variáveis aceitas (a primeira que existir):
 *   SSX_USERNAME  | TRACKING_USERNAME
 *   SSX_PASSWORD  | TRACKING_PASSWORD
 *   SSX_HASH_AUTH | TRACKING_HASH_AUTH
 *   SSX_BASE      (opcional; padrão tenta https e cai para http)
 *
 * Contexto (07/10/2026). Ideia do José: cruzar, na aba Mapa, a trilha do
 * veículo (SSX) com o endereço da nota e as coordenadas dos apontamentos WPA,
 * lendo a SSX SOB DEMANDA, sem gravar nada. Antes da spec faltam 2 respostas
 * que o manual (SSX_API_MANUAL.md) NÃO dá:
 *
 *   1. RETENÇÃO — até quanto tempo atrás a SSX devolve posições?
 *      → consulta a mesma placa em D-1, D-7, D-30, D-90, D-180, D-365.
 *   2. FUSO — o EventDate vem em UTC ou em horário de Brasília?
 *      (o manual §7 admite que a doc é inconsistente)
 *      → compara o EventDate mais recente de HOJE com o relógio agora.
 *
 * Usa só POST /Login e POST /v3/Tracking/PositionHistory/List (leitura).
 * Nenhum endpoint de escrita/comando (manual §10). Não grava nada, não
 * imprime senha nem token, não imprime motorista nem CPF (DocumentNumber).
 */

const path = require('path');
const ARGS = process.argv.slice(2);
const envIdx = ARGS.indexOf('--credenciais');
if (envIdx >= 0) {
  const p = ARGS[envIdx + 1];
  if (!p) { console.error('--credenciais sem caminho'); process.exit(2); }
  const arq = path.resolve(p.replace(/^~/, process.env.HOME || '~'));
  if (!require('fs').existsSync(arq)) { console.error(`--credenciais: arquivo não existe: ${arq}`); process.exit(2); }
  require('dotenv').config({ path: arq });
  ARGS.splice(envIdx, 2);
}
require('dotenv').config(); // .env do WPA Monitor (não sobrescreve o de cima)

const PLACA = (ARGS[0] || 'TIO2G36').toUpperCase().replace(/[^A-Z0-9]/g, '');
const USER  = process.env.SSX_USERNAME  || process.env.TRACKING_USERNAME;
const PASS  = process.env.SSX_PASSWORD  || process.env.TRACKING_PASSWORD;
const HASH  = process.env.SSX_HASH_AUTH || process.env.TRACKING_HASH_AUTH;
const BASES = process.env.SSX_BASE
  ? [process.env.SSX_BASE]
  : ['https://integration.systemsatx.com.br', 'http://integration.systemsatx.com.br'];

const DIAS_ATRAS = [1, 7, 30, 90, 180, 365];
const PAUSA_MS   = 2000;   // chamadas serializadas — limite do 429 não é publicado
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!USER || !PASS || !HASH) {
  console.error('Credenciais ausentes. Defina SSX_USERNAME/SSX_PASSWORD/SSX_HASH_AUTH no .env');
  console.error('ou aponte para o .env do GSEQ:  node scripts/probe-ssx.js PLACA --credenciais ~/gseq/.env');
  process.exit(2);
}

// ── Datas ────────────────────────────────────────────────────────────────────
// Dia D em Brasília (UTC-3, sem horário de verão desde 2019).
function diaBRT(diasAtras) {
  return new Date(Date.now() - 3 * 3600e3 - diasAtras * 86400e3).toISOString().slice(0, 10);
}
const fmtMin = ms => (ms / 60000).toFixed(0) + ' min';

// ── HTTP ─────────────────────────────────────────────────────────────────────
let BASE = null;

async function login() {
  const body = new URLSearchParams({ Username: USER, Password: PASS, HashAuth: HASH });
  for (const b of BASES) {
    try {
      const r = await fetch(b + '/Login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000),
      });
      const txt = await r.text();
      if (!r.ok) {
        console.log(`  ${b}: HTTP ${r.status} ${txt.slice(0, 120).replace(/\s+/g, ' ')}`);
        continue;
      }
      let j; try { j = JSON.parse(txt); } catch { j = null; }
      if (!j || !j.AccessToken) {
        // HTML grande com <!DOCTYPE> = portal de bloqueio do Fortinet
        console.log(`  ${b}: 200 sem AccessToken (${txt.length} bytes, começa com "${txt.slice(0, 40).replace(/\s+/g, ' ')}")`);
        continue;
      }
      BASE = b;
      console.log(`  ${b}: OK — token de ${j.AccessToken.length} chars, ExpiresIn=${j.ExpiresIn}`);
      return j.AccessToken;
    } catch (e) {
      const code = (e.cause && (e.cause.code || e.cause.message)) || e.message;
      console.log(`  ${b}: falhou (${code})`);
    }
  }
  return null;
}

async function historico(token, filtros) {
  for (let tent = 0; tent < 4; tent++) {
    const r = await fetch(BASE + '/v3/Tracking/PositionHistory/List', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(filtros),
      signal: AbortSignal.timeout(60000),
    });
    if (r.status === 429) {
      const espera = (Number(r.headers.get('retry-after')) * 1000) || 5000 * 2 ** tent;
      console.log(`    429 limite de consulta — aguardando ${espera / 1000}s`);
      await sleep(espera);
      continue;
    }
    if (r.status === 204) return { status: 204, lista: [] };
    const txt = await r.text();
    if (!r.ok) return { status: r.status, erro: txt.slice(0, 200).replace(/\s+/g, ' '), lista: [] };
    const j = JSON.parse(txt);
    const lista = Array.isArray(j) ? j : (j.Result || j.Data || []);
    return { status: r.status, lista };
  }
  return { status: 429, erro: '429 após 4 tentativas', lista: [] };
}

function filtrosDia(dia) {
  return [
    { PropertyName: 'Plate',     Condition: '=',  Value: PLACA },
    { PropertyName: 'EventDate', Condition: '>=', Value: `${dia}T00:00:00` },
    { PropertyName: 'EventDate', Condition: '<=', Value: `${dia}T23:59:59` },
  ];
}

function resumo(lista) {
  if (!lista.length) return null;
  const ev = lista.map(p => p.EventDate).sort();
  return {
    n: lista.length,
    primeiro: ev[0],
    ultimo: ev[ev.length - 1],
    ignicao: lista.filter(p => p.Ignition).length,
    gpsInvalido: lista.filter(p => p.ValidGPS === false).length,
    placas: [...new Set(lista.map(p => p.Plate || '∅'))].join(','),
    unidade: [...new Set(lista.map(p => p.TrackedUnit || '∅'))].slice(0, 2).join(' | '),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n== probe-ssx — placa ${PLACA} — ${new Date().toISOString()}\n`);

  console.log('1. Login');
  const token = await login();
  if (!token) { console.log('\nSem login — pare aqui e me mande a saída acima.'); process.exit(1); }

  // ── 2. Fuso ──
  console.log(`\n2. Fuso — posições de HOJE (${diaBRT(0)}) da placa`);
  const hoje = await historico(token, filtrosDia(diaBRT(0)));
  if (hoje.erro) console.log(`   HTTP ${hoje.status}: ${hoje.erro}`);
  const rh = resumo(hoje.lista);
  if (!rh) {
    console.log('   nenhuma posição hoje (veículo desligado/sem sinal?) — rode de novo em horário de operação');
  } else {
    // Pega a posição mais recente por IdPosition e mostra os campos de data CRUS
    const ult = hoje.lista.reduce((a, b) => (b.IdPosition > a.IdPosition ? b : a));
    const agora = Date.now();
    const evComoUTC   = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(ult.EventDate) ? ult.EventDate : ult.EventDate + 'Z');
    const evComoLocal = Date.parse(ult.EventDate.replace(/[zZ]$/, '') + '-03:00');
    console.log(`   ${rh.n} posições${rh.n >= 500 ? ' (TRUNCADO em 500)' : ''}`);
    console.log(`   mais recente (IdPosition ${ult.IdPosition}):`);
    console.log(`     EventDate  cru: ${ult.EventDate}`);
    console.log(`     UpdateDate cru: ${ult.UpdateDate}`);
    console.log(`     endereço      : ${ult.Address || '∅'}`);
    console.log(`   relógio agora   : ${new Date(agora).toISOString()} UTC`);
    console.log(`   se EventDate for UTC     → idade ${fmtMin(agora - evComoUTC)}`);
    console.log(`   se EventDate for Brasília→ idade ${fmtMin(agora - evComoLocal)}`);
    console.log('   → a hipótese com idade pequena e POSITIVA é a certa. Idade negativa = hipótese errada.');
    console.log('   → confirme no portal SSX: a posição desse endereço tem que mostrar a mesma hora.');
  }

  // ── 3. Retenção ──
  console.log('\n3. Retenção — mesma placa em dias passados');
  console.log('   dias  data        status  pontos  primeiro → último                         ign  gpsInv');
  for (const d of DIAS_ATRAS) {
    await sleep(PAUSA_MS);
    const dia = diaBRT(d);
    const r = await historico(token, filtrosDia(dia));
    const s = resumo(r.lista);
    const linha = s
      ? `${String(s.n).padStart(6)}${s.n >= 500 ? '+' : ' '} ${s.primeiro} → ${s.ultimo}  ${String(s.ignicao).padStart(4)}  ${String(s.gpsInvalido).padStart(6)}`
      : `     0  ${r.erro || '(vazio)'}`;
    console.log(`   ${String(d).padStart(4)}  ${dia}  ${String(r.status).padStart(6)}  ${linha}`);
    if (s && d === 1) console.log(`         Plate=${s.placas}  TrackedUnit=${s.unidade}`);
  }

  console.log('\nComo ler:');
  console.log('  - Pontos > 0 num dia antigo = a SSX ainda guarda aquele dia.');
  console.log('  - Primeiro dia com 0 (e o anterior com dados) = limite da retenção.');
  console.log('  - "500+" = há mais pontos naquele dia (uma chamada traz no máximo 500).');
  console.log('  - Tudo 0, inclusive D-1: placa com outro formato na SSX, ou veículo parado.');
  console.log('    Rode com outra placa:  node scripts/probe-ssx.js SHU2I06 ...\n');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
