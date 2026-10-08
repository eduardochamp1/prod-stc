#!/usr/bin/env node
/**
 * scripts/probe-ssx.js
 * SONDA READ-ONLY da API do rastreador veicular SystemSatX (SSX).
 *
 * Uso (na VM):
 *   cd ~/prod-stc && node scripts/probe-ssx.js [PLACA] [--credenciais CAMINHO]
 *   cd ~/prod-stc && node scripts/probe-ssx.js --frota ARQ [--credenciais CAMINHO]
 *
 *   PLACA        placa Mercosul sem hífen (padrão: TIO2G36, ECASJ84/SJC)
 *   --frota ARQ  em vez da sonda de placa, compara as placas do arquivo ARQ
 *                (separadas por vírgula ou quebra de linha) com o CADASTRO de
 *                veículos da SSX (/Tracking/Vehicle/v2/List) — mostra quais
 *                equipes ficariam sem trilha.
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
 * lendo a SSX SOB DEMANDA, sem gravar nada. Antes da spec faltam respostas
 * que o manual (SSX_API_MANUAL.md) NÃO dá: retenção, fuso, formato da placa
 * e cobertura da frota.
 *
 * Já medido na VM (08/10/2026, 3 rodadas):
 *   - login por https funciona apesar do Fortinet;
 *   - ExpiresIn é DateTime.Ticks do .NET (instante absoluto, +24h), não duração;
 *   - EventDate vem em UTC com "Z", e o FILTRO de data sem fuso também é UTC
 *     (pedir "2026-10-06T00:00:00" trouxe 00:07Z = 21h do dia 05 em Brasília).
 *     Por isso o dia aqui é [D 03:00Z, D+1 03:00Z);
 *   - Plate vem quase sempre com hífen ("TZW-7G19"), às vezes sem ("SHD8E40");
 *   - 429 já na 3ª chamada: limite apertado — pausa de 4s entre chamadas;
 *   - TZW-7G19: D-1 com 500+ pontos, D-7 vazio → retenção curta OU o veículo
 *     parou. O passo 4 mede a retenção SEM filtro de placa para separar isso.
 *
 * Usa só POST /Login, /v3/Tracking/PositionHistory/List e
 * /Tracking/Vehicle/v2/List (leitura). Nenhum endpoint de escrita/comando
 * (manual §10). Não grava nada, não imprime senha nem token, não imprime
 * motorista nem CPF (DocumentNumber).
 */

const fs   = require('fs');
const path = require('path');
const ARGS = process.argv.slice(2);

function tirarOpcao(nome) {
  const i = ARGS.indexOf(nome);
  if (i < 0) return null;
  const v = ARGS[i + 1];
  if (!v) { console.error(`${nome} sem valor`); process.exit(2); }
  ARGS.splice(i, 2);
  const arq = path.resolve(v.replace(/^~/, process.env.HOME || '~'));
  if (!fs.existsSync(arq)) { console.error(`${nome}: arquivo não existe: ${arq}`); process.exit(2); }
  return arq;
}
const ARQ_CRED  = tirarOpcao('--credenciais');
const ARQ_FROTA = tirarOpcao('--frota');
if (ARQ_CRED) require('dotenv').config({ path: ARQ_CRED });
require('dotenv').config(); // .env do WPA Monitor (não sobrescreve o de cima)

const PLACA = (ARGS[0] || 'TIO2G36').toUpperCase().replace(/[^A-Z0-9]/g, '');
const USER  = process.env.SSX_USERNAME  || process.env.TRACKING_USERNAME;
const PASS  = process.env.SSX_PASSWORD  || process.env.TRACKING_PASSWORD;
const HASH  = process.env.SSX_HASH_AUTH || process.env.TRACKING_HASH_AUTH;
const BASES = process.env.SSX_BASE
  ? [process.env.SSX_BASE]
  : ['https://integration.systemsatx.com.br', 'http://integration.systemsatx.com.br'];

const DIAS_PLACA = [1, 2, 3, 4, 5, 6, 7];
const DIAS_FROTA = [1, 2, 3, 4, 5, 6, 7, 10, 14, 30, 60, 90];
const PAUSA_MS   = 4000;   // 429 veio já na 3ª chamada com 2s (08/10/2026)
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
// Instante UTC (ISO com Z) de "dia às hh:mm de Brasília" + delta em minutos.
function utcDeBRT(dia, hhmm, deltaMin = 0) {
  return new Date(Date.parse(`${dia}T${hhmm}:00-03:00`) + deltaMin * 60e3).toISOString();
}
const fmtMin = ms => (ms / 60000).toFixed(0) + ' min';
const fmtBRT = iso => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// TrackedUnit é texto livre do cadastro SSX e às vezes traz NOME do motorista
// ("STT-9J51 <nome> 30.084", visto na VM em 08/10/2026). Só a 1ª palavra
// (a placa) sai na tela; o resto vira "…".
const unidSegura = s => { const t = String(s || '∅').trim().split(/\s+/); return t[0] + (t.length > 1 ? ' …' : ''); };

// ── HTTP ─────────────────────────────────────────────────────────────────────
let BASE = null;
let TOKEN = null;

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
      console.log(`  ${b}: OK`);
      return j.AccessToken;
    } catch (e) {
      const code = (e.cause && (e.cause.code || e.cause.message)) || e.message;
      console.log(`  ${b}: falhou (${code})`);
    }
  }
  return null;
}

async function post(rota, corpo) {
  for (let tent = 0; tent < 5; tent++) {
    const r = await fetch(BASE + rota, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corpo),
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
  return { status: 429, erro: '429 após 5 tentativas', lista: [] };
}
const historico = filtros => post('/v3/Tracking/PositionHistory/List', filtros);

// Valor da placa como a SSX grava — descoberto no passo 2. 1ª rodada na VM
// (08/10/2026): "TIO2G36" deu 204 em TODOS os dias, inclusive D-1; o GSEQ
// assume placa com hífen ("ABC-1234", tracking-backfill.ts:81).
let PLACA_SSX = PLACA;

function filtrosDia(dia) {
  return [
    { PropertyName: 'Plate',     Condition: '=',  Value: PLACA_SSX },
    { PropertyName: 'EventDate', Condition: '>=', Value: utcDeBRT(dia, '00:00') },
    { PropertyName: 'EventDate', Condition: '<',  Value: utcDeBRT(dia, '00:00', 24 * 60) },
  ];
}
// 5 min às 10:00 de Brasília, sem filtro de placa (horário de frota rodando).
function filtrosAmostra(dia) {
  return [
    { PropertyName: 'EventDate', Condition: '>=', Value: utcDeBRT(dia, '10:00') },
    { PropertyName: 'EventDate', Condition: '<',  Value: utcDeBRT(dia, '10:00', 5) },
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
  };
}

// ── Modo --frota: nossas placas × cadastro SSX ───────────────────────────────
async function modoFrota() {
  const nossas = [...new Set(fs.readFileSync(ARQ_FROTA, 'utf8').split(/[,\s]+/).map(norm).filter(Boolean))];
  console.log(`\n2. Frota — ${nossas.length} placas do arquivo × cadastro de veículos da SSX`);
  let r = await post('/Tracking/Vehicle/v2/List', [{ PropertyName: 'LicensePlate', Condition: 'Contains', Value: '' }]);
  if (!r.lista.length) {
    console.log(`   filtro Contains "": HTTP ${r.status}${r.erro ? ' — ' + r.erro : ''} — tentando []`);
    await sleep(PAUSA_MS);
    r = await post('/Tracking/Vehicle/v2/List', []);
  }
  if (!r.lista.length) { console.log(`   cadastro vazio: HTTP ${r.status}${r.erro ? ' — ' + r.erro : ''}`); return; }

  const cad = new Map();   // placa normalizada → { LicensePlate, UEN }
  for (const v of r.lista) {
    const k = norm(v.LicensePlate);
    if (k) cad.set(k, { placa: v.LicensePlate, uen: v.OrganizationalUnitIntegrationCode || '∅' });
  }
  console.log(`   cadastro SSX: ${r.lista.length} veículos (${cad.size} placas distintas)${r.lista.length >= 500 ? ' — pode estar TRUNCADO em 500' : ''}`);

  const tem   = nossas.filter(p => cad.has(p));
  const falta = nossas.filter(p => !cad.has(p));
  console.log(`   no cadastro SSX: ${tem.length}/${nossas.length}    fora: ${falta.length}`);
  const porUen = {};
  for (const p of tem) { const u = cad.get(p).uen; porUen[u] = (porUen[u] || 0) + 1; }
  console.log(`   UEN SSX das que estão: ${Object.entries(porUen).map(([u, n]) => `${u}=${n}`).join('  ')}`);
  if (falta.length) console.log(`   FORA da SSX: ${falta.join(', ')}`);
}

// ── Modo padrão: sonda de uma placa ──────────────────────────────────────────
async function modoPlaca() {
  // ── 2. Formato da placa ──
  const d1 = diaBRT(1);
  console.log(`\n2. Formato da placa — amostra de ${d1} 10:00–10:05 (Brasília), sem filtro de placa`);
  const amostra = await historico(filtrosAmostra(d1));
  console.log(`   HTTP ${amostra.status}, ${amostra.lista.length} posições${amostra.erro ? ' — ' + amostra.erro : ''}`);
  const achou = amostra.lista.find(p => norm(p.Plate) === PLACA || norm(p.TrackedUnit).startsWith(PLACA));
  if (achou) {
    PLACA_SSX = achou.Plate || PLACA_SSX;
    console.log(`   ✔ ${PLACA} está na amostra como Plate=${JSON.stringify(achou.Plate)}, TrackedUnit=${JSON.stringify(unidSegura(achou.TrackedUnit))}`);
  } else {
    console.log(`   ${PLACA} não apareceu nesses 5 min — testando variantes`);
    for (const v of [PLACA, PLACA.slice(0, 3) + '-' + PLACA.slice(3)]) {
      await sleep(PAUSA_MS);
      PLACA_SSX = v;
      const r = await historico(filtrosDia(d1));
      console.log(`   Plate = ${JSON.stringify(v)} em ${d1}: HTTP ${r.status}, ${r.lista.length} posições`);
      if (r.lista.length) break;
    }
  }
  console.log(`   → seguindo com Plate = ${JSON.stringify(PLACA_SSX)}`);

  // ── 3. Fuso ──
  await sleep(PAUSA_MS);
  console.log(`\n3. Fuso — posições de HOJE (${diaBRT(0)}) da placa`);
  const hoje = await historico(filtrosDia(diaBRT(0)));
  if (hoje.erro) console.log(`   HTTP ${hoje.status}: ${hoje.erro}`);
  if (!hoje.lista.length) {
    console.log('   nenhuma posição hoje (veículo desligado/sem sinal?)');
  } else {
    const ult = hoje.lista.reduce((a, b) => (b.IdPosition > a.IdPosition ? b : a));
    const agora = Date.now();
    const evComoUTC   = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(ult.EventDate) ? ult.EventDate : ult.EventDate + 'Z');
    const evComoLocal = Date.parse(ult.EventDate.replace(/[zZ]$/, '') + '-03:00');
    console.log(`   ${hoje.lista.length} posições${hoje.lista.length >= 500 ? ' (TRUNCADO em 500)' : ''}`);
    console.log(`   mais recente: EventDate=${ult.EventDate}  UpdateDate=${ult.UpdateDate}`);
    console.log(`   se UTC → idade ${fmtMin(agora - evComoUTC)}  |  se Brasília → idade ${fmtMin(agora - evComoLocal)}`);
  }

  // ── 4a. Retenção da placa ──
  console.log(`\n4a. Retenção — placa ${PLACA_SSX}, dia inteiro de Brasília`);
  console.log('   dias  data        status  pontos  primeiro → último (Brasília)   ign  gpsInv');
  for (const d of DIAS_PLACA) {
    await sleep(PAUSA_MS);
    const dia = diaBRT(d);
    const r = await historico(filtrosDia(dia));
    const s = resumo(r.lista);
    const linha = s
      ? `${String(s.n).padStart(6)}${s.n >= 500 ? '+' : ' '} ${fmtBRT(s.primeiro)} → ${fmtBRT(s.ultimo)}  ${String(s.ignicao).padStart(4)}  ${String(s.gpsInvalido).padStart(6)}`
      : `     0  ${r.erro || '(vazio)'}`;
    console.log(`   ${String(d).padStart(4)}  ${dia}  ${String(r.status).padStart(6)}  ${linha}`);
  }
}

// ── 4b. Retenção da frota (independe de um veículo ter rodado) ───────────────
async function retencaoFrota() {
  console.log('\n4b. Retenção — FROTA inteira, 5 min às 10:00 de Brasília (sem filtro de placa)');
  console.log('   dias  data        status  posições  veículos');
  for (const d of DIAS_FROTA) {
    await sleep(PAUSA_MS);
    const dia = diaBRT(d);
    const r = await historico(filtrosAmostra(dia));
    const veic = new Set(r.lista.map(p => norm(p.Plate || p.TrackedUnit))).size;
    console.log(`   ${String(d).padStart(4)}  ${dia}  ${String(r.status).padStart(6)}  ${String(r.lista.length).padStart(8)}${r.lista.length >= 500 ? '+' : ' '} ${String(veic).padStart(8)}${r.erro ? '  ' + r.erro : ''}`);
  }
  console.log('   → o 1º dia com 0 posições na FROTA é o limite da retenção da SSX.');
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n== probe-ssx — ${ARQ_FROTA ? 'frota' : 'placa ' + PLACA} — ${new Date().toISOString()}\n`);
  console.log('1. Login');
  TOKEN = await login();
  if (!TOKEN) { console.log('\nSem login — pare aqui e me mande a saída acima.'); process.exit(1); }

  if (ARQ_FROTA) {
    await modoFrota();
  } else {
    await modoPlaca();
    await retencaoFrota();
  }
  console.log('');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
