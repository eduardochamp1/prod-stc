/**
 * db/heQueries.js
 *
 * FASE 2 da SPEC-medicao-he-2026-09-09 — o cálculo da hora extra.
 *
 * Antecipação = quanto a sessão começou ANTES da escala.
 * Prorrogação = quanto a sessão terminou DEPOIS da escala.
 * Total = antecipação + prorrogação  (decisão do José em 09/09/2026).
 * Valor = total × valor/hora do tipo da equipe.
 *
 * ── A ARMADILHA CENTRAL: FUSO ───────────────────────────────────────────────
 * Tudo aqui é HORA DE PAREDE (relógio da operação, BRT), e de propósito:
 *   • `escalas_catalogo.inicio_escala/fim_escala` são TIME sem fuso;
 *   • `snapshots.session_begin/session_end` são texto ISO SEM marcador de fuso
 *     — é o que a API do WPA devolve;
 *   • a VM roda em UTC.
 * Converter qualquer um dos lados erra 3 horas, e 3 horas de hora extra a
 * R$ 376,28 são R$ 1.128 por linha. Então NÃO se converte nada: os dois lados
 * são lidos como parede e só a DIFERENÇA é usada. É a mesma armadilha que já
 * pegou o TMA (PO) e o KPI de escala (ver `db/escalaQueries.js:137`).
 *
 * ── VIRA-NOITE: NÃO É HIPÓTESE ──────────────────────────────────────────────
 * Medido no print de 09/09/2026: `EBGPR64` em 24/07 tem fim de escala 17:00 e
 * fim de sessão **25/07 00:02** — 423 min. E o catálogo tem turnos que já
 * começam virando (C17 17:00→02:00, C18 18:00→03:00, C35 22:35→06:00), então o
 * FIM DE ESCALA também pode ser do dia seguinte. Comparar horários sem resolver
 * a data dá prorrogação negativa ou de ~17h. Mesma família do P1-14.
 */

'use strict';

const { _getPool } = require('../services/pgShim');
const { VALORES_HORA_SEED, TIPOS_BREVE } = require('./heCadastroSeed');

const MS_DIA  = 86400000;
const MS_HORA = 3600000;

/** BRT é fixo em UTC−3 (sem horário de verão desde 2019). */
const BRT_OFFSET_MIN = -180;

// ─────────────────────────────────────────────────────────────────────────────
// Leitura de instantes — FUNÇÕES PURAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FUNÇÃO PURA (testável): instante em ms lido como HORA DE PAREDE.
 *
 * O referencial é UTC fictício. Não importa qual seja, desde que os DOIS lados
 * da subtração sejam lidos do mesmo jeito — e é justamente por isso que existe
 * uma função só pra isso, em vez de `new Date()` espalhado.
 *
 * Sem marcador de fuso (o caso normal do WPA): lê a parede como está.
 * Com `Z` ou offset explícito: converte pra parede BRT antes de devolver, pra
 * uma eventual mudança de formato da EDP não passar em silêncio.
 */
function msParede(iso) {
  if (iso == null) return null;
  const s = String(iso).trim();
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/);
  if (!m) return null;
  const ms = String(m[7] || '0').padEnd(3, '0');
  let base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +ms);
  if (!Number.isFinite(base)) return null;

  const resto = s.slice(m[0].length);
  if (/^z$/i.test(resto)) {
    base += BRT_OFFSET_MIN * 60000;                 // UTC → parede BRT
  } else {
    const off = resto.match(/^([+-])(\d{2}):?(\d{2})/);
    if (off) {
      const offMin = (off[1] === '-' ? -1 : 1) * (+off[2] * 60 + +off[3]);
      base += (BRT_OFFSET_MIN - offMin) * 60000;
    }
  }
  return base;
}

/** 'HH:MM' | 'HH:MM:SS' | Date do pg → 'HH:MM:SS'. null se não reconhece. */
function normHora(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const h = +m[1], mi = +m[2], se = +(m[3] || 0);
  if (h > 23 || mi > 59 || se > 59) return null;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(mi)}:${p(se)}`;
}

/**
 * FUNÇÃO PURA (testável): janela real da escala, resolvendo o vira-noite.
 *
 * `fim <= inicio` significa que o turno atravessa a meia-noite, então o fim é
 * no dia seguinte. `fim === inicio` é janela AMBÍGUA (24h? erro de cadastro?) e
 * devolve null em vez de adivinhar — mesma regra de `escalaQueries.turnoCobreAgora`.
 */
function janelaDaEscala(dataISO, inicio, fim) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataISO || ''))) return null;
  const hi = normHora(inicio), hf = normHora(fim);
  if (!hi || !hf) return null;
  const inicioMs = msParede(`${dataISO}T${hi}`);
  let fimMs      = msParede(`${dataISO}T${hf}`);
  if (inicioMs == null || fimMs == null) return null;
  if (fimMs === inicioMs) return null;              // ambígua — não adivinha
  if (fimMs < inicioMs) fimMs += MS_DIA;            // vira a meia-noite
  return { inicioMs, fimMs };
}

/**
 * FUNÇÃO PURA (testável): a janela MAIS AMPLA entre vários códigos de escala
 * no mesmo dia.
 *
 * `escala_dia` é por COLABORADOR, então uma equipe pode ter dois códigos no
 * mesmo dia. Pegar a janela mais ampla (menor início, maior fim) é deliberado:
 * escala mais larga = MENOS hora extra. Na dúvida, subnotificar a favor da
 * EDP — o contrário é cobrar hora que talvez não exista.
 */
function janelaMaisAmpla(dataISO, pares) {
  let out = null;
  for (const p of (pares || [])) {
    const j = janelaDaEscala(dataISO, p.inicio_escala, p.fim_escala);
    if (!j) continue;
    if (!out) { out = { ...j }; continue; }
    out.inicioMs = Math.min(out.inicioMs, j.inicioMs);
    out.fimMs    = Math.max(out.fimMs, j.fimMs);
  }
  return out;
}

/**
 * FUNÇÃO PURA (testável): a sessão do dia a partir de N sessões (relogin).
 *
 * Regra: PRIMEIRO login e ÚLTIMO logoff. A equipe esteve em campo do primeiro
 * ao último — somar cada sessão em separado cobraria duas antecipações pela
 * mesma manhã.
 *
 * Sessão sem `end` é sessão ABERTA: `fimMs` volta null e a linha fica marcada
 * como incompleta. Inventar um fim (agora? fim da escala?) seria criar
 * prorrogação que ninguém mediu.
 */
function sessaoDoDia(sessoes) {
  const lista = (sessoes || [])
    .map(s => ({ ini: msParede(s.begin), fim: msParede(s.end) }))
    .filter(s => s.ini != null);
  if (!lista.length) return null;

  const inicioMs = Math.min(...lista.map(s => s.ini));
  const aberta   = (sessoes || []).some(s => !s.end);
  const fins     = lista.map(s => s.fim).filter(v => v != null);
  return {
    inicioMs,
    fimMs:    aberta || !fins.length ? null : Math.max(...fins),
    relogins: Math.max(0, lista.length - 1),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// O cálculo — FUNÇÕES PURAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FUNÇÃO PURA (testável): antecipação, prorrogação e total.
 *
 * `Math.max(0, …)` nos dois lados: entrar depois da escala não é "antecipação
 * negativa", é zero. Sem isso, sair 40 min depois e entrar 40 min atrasado se
 * anulariam e a hora extra desapareceria.
 *
 * `incompleta` marca o que não deu pra medir. A linha aparece, mas o valor não
 * é apresentado como se fosse fechado.
 */
function calcularHe(janela, sessao) {
  if (!janela || !sessao) return null;
  const antMs = sessao.inicioMs == null ? null
    : Math.max(0, janela.inicioMs - sessao.inicioMs);
  const proMs = sessao.fimMs == null ? null
    : Math.max(0, sessao.fimMs - janela.fimMs);
  const totalMs = (antMs || 0) + (proMs || 0);

  return {
    antecipacao_h: antMs == null ? null : antMs / MS_HORA,
    prorrogacao_h: proMs == null ? null : proMs / MS_HORA,
    total_h: totalMs / MS_HORA,
    // ⚠️ EM MILISSEGUNDOS, sem passar por horas. O piso é comparado contra
    // isto porque `total_h * 3600` de uma diferença de 60.000 ms dá
    // 59,99999999999999 — erro de float que descartaria uma linha legítima de
    // exatamente 1 minuto. Manter a unidade inteira até a comparação resolve.
    total_ms: totalMs,
    // Arredondamentos são de EXIBIÇÃO. O dinheiro sai de `total_h` cru — ver
    // `valorTotalHe`, e a prova do 0,719 × 376,28 = 270,36 na spec §4.
    total_dec: Math.round((totalMs / MS_HORA) * 100) / 100,
    total_min: Math.round(totalMs / 60000),
    incompleta: antMs == null || proMs == null,
  };
}

/**
 * FUNÇÃO PURA (testável): valor total da linha.
 *
 * ⚠️ Usa `total_h` CRU, nunca o `total_dec` arredondado. Conferido contra a
 * planilha: 0,7185 h × R$ 376,28 = R$ 270,36 (com o arredondado daria
 * R$ 270,92). Por linha são centavos; em 327 linhas por mês, acumula.
 *
 * Sem valor/hora devolve null — NUNCA zero. Zero pareceria "não há o que
 * cobrar"; null aparece como vazio e a tela avisa que falta cadastro.
 */
function valorTotalHe(totalH, valorHora) {
  if (totalH == null || !Number.isFinite(totalH)) return null;
  if (valorHora == null || !Number.isFinite(valorHora) || valorHora <= 0) return null;
  return Math.round(totalH * valorHora * 100) / 100;
}

/**
 * PISO da medição: 1 minuto. Decisão do José em 09/09/2026, depois de ver dado
 * real.
 *
 * Na 1ª rodada o critério era "qualquer ponta > 0", e apareceu a `ECGPR51` com
 * prorrogação de 0,003 h — ONZE SEGUNDOS — cobrando R$ 0,86 com TOTAL (M) = 0.
 * Isso não é hora extra, é jitter de sincronização do app. E uma linha de 11
 * segundos numa planilha de cobrança é o que um auditor usa pra questionar as
 * outras 405.
 */
const PISO_HE_SEG = 60;

/**
 * FUNÇÃO PURA (testável): a linha entra na medição?
 *
 * Precisa de hora extra em alguma ponta E de total no piso.
 *
 * ⚠️ SESSÃO ABERTA PASSA SEM O PISO. Com a sessão em aberto a prorrogação é
 * DESCONHECIDA, então não se pode afirmar que o total está abaixo de 1 minuto —
 * pode ser de horas. A linha fica, marcada `incompleta`, e a tela avisa.
 * Aplicar o piso ali esconderia justamente o caso que precisa de conferência.
 */
function temHe(he, pisoSeg = PISO_HE_SEG) {
  if (!he) return false;
  if (!((he.antecipacao_h > 0) || (he.prorrogacao_h > 0))) return false;
  if (he.incompleta) return true;
  return Number(he.total_ms) >= pisoSeg * 1000;
}

/**
 * FUNÇÃO PURA (testável): rótulo da última nota, no formato da planilha
 * (`PO - 104740451 - Executada`).
 *
 * ⚠️ O vocabulário de status da planilha vem do PORTAL e é mais rico que o
 * nosso: ela tem "Interrompida"/"Interrompido", que não existe nos snapshots
 * (só 'executada' | 'concluida' | 'rejeitada'). Então não se traduz por
 * aproximação — capitaliza o que temos e a Fase 4 confere onde divergir.
 */
function rotuloUltimaNota(nota) {
  if (!nota) return null;
  const tipo = nota.tipoCode || nota.tipoNome || '??';
  const num  = nota.codigo || nota.id || '';
  // Acentuação explícita: `concluida` vem sem acento do snapshot, e este texto
  // vai numa planilha enviada à EDP. Status desconhecido é só capitalizado —
  // inventar tradução seria pior que mostrar o termo cru.
  const ROTULOS = { executada: 'Executada', concluida: 'Concluída', rejeitada: 'Rejeitada' };
  const bruto = nota.status ? String(nota.status).toLowerCase() : null;
  const st = bruto
    ? (ROTULOS[bruto] || bruto.charAt(0).toUpperCase() + bruto.slice(1))
    : null;
  return [tipo, num, st].filter(Boolean).join(' - ');
}

/**
 * FUNÇÃO PURA (testável): a última nota trabalhada na sessão.
 *
 * Junta concluídas + rejeitadas + executadas e devolve a de conclusão mais
 * recente. Nota sem data de conclusão não pode vencer — sem instante, não há
 * como afirmar que foi a última.
 */
function ultimaNotaDaSessao(payload) {
  const p = payload || {};
  const todas = [
    ...(p.notasConcluidas || []),
    ...(p.notasRejeitadas || []),
    ...(p.notasExecutadas || []),
  ].filter(Boolean);
  let melhor = null, melhorMs = -Infinity;
  for (const n of todas) {
    const ms = msParede(n.conclusionDate);
    if (ms == null) continue;
    if (ms > melhorMs) { melhorMs = ms; melhor = n; }
  }
  return melhor ? { nota: melhor, conclusaoMs: melhorMs } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRA DO "ACORDO 30 MIN" — pedido do José em 09/09/2026
//
// "quando uma equipe aponta o deslocamento para a última nota do dia pelo menos
// 30 minutos antes do fim da escala".
//
// A lógica de negócio: se a equipe JÁ ESTAVA a caminho da última nota bem antes
// do turno fechar, a hora extra é legítima — ela foi despachada em tempo e o
// serviço simplesmente passou do horário. É a justificativa que hoje é
// preenchida à mão na coluna AUTORIZADO POR, onde 'ACORDO 30 MINUTOS' é um dos
// valores da lista AFIRMATIVAS.
// ─────────────────────────────────────────────────────────────────────────────

/** Checkpoint 0 = Início do Deslocamento (docs/handoff/API-WPA-EDP.md §297). */
const EVENT_INICIO_DESLOC = 0;
const ACORDO_MARGEM_SEG = 30 * 60;

/**
 * FUNÇÃO PURA (testável): quando a equipe começou a se deslocar pra nota.
 *
 * Devolve o PRIMEIRO `event = 0`. Uma nota pode ter vários — "cada novo
 * event=0 começa uma tentativa" (API-WPA-EDP §299) — e a pergunta é "foi
 * despachada em tempo?", que fala do primeiro despacho, não da última
 * tentativa. Usar o último premiaria quem tentou de novo tarde.
 *
 * ⚠️ Lê `registradoEm` (que vem de `RegisteredAt2`), NUNCA `TimeStamp`. Nos
 * eventos 0 e 1 o `TimeStamp` é o relógio do aparelho no momento da
 * SINCRONIZAÇÃO: medido na nota 104875481, deu 55 min de erro no evento 0.
 * Ver a tabela em `docs/handoff/API-WPA-EDP.md`.
 */
function inicioDeslocamento(checkpoints) {
  let menor = null;
  for (const cp of (checkpoints || [])) {
    if (!cp || Number(cp.event) !== EVENT_INICIO_DESLOC) continue;
    const ms = msParede(cp.registradoEm);
    if (ms == null) continue;
    if (menor == null || ms < menor) menor = ms;
  }
  return menor;
}

/**
 * FUNÇÃO PURA (testável): a condição do acordo foi cumprida?
 *
 * `true` só quando o deslocamento começou com pelo menos 30 min de folga antes
 * do fim da escala. "Pelo menos 30" inclui exatamente 30, então a fronteira é
 * inclusiva.
 *
 * ⚠️ Devolve **null quando não dá pra avaliar** (sem checkpoint, sem escala) —
 * nunca `false`. Falso diria "conferimos e não cumpre", o que é afirmação
 * sobre a equipe; null diz "não sei", que é a verdade. A distinção importa
 * porque essa coluna vira justificativa de cobrança.
 */
function acordo30(inicioDeslocMs, fimEscalaMs, margemSeg = ACORDO_MARGEM_SEG) {
  if (inicioDeslocMs == null || fimEscalaMs == null) return null;
  if (!Number.isFinite(inicioDeslocMs) || !Number.isFinite(fimEscalaMs)) return null;
  return inicioDeslocMs <= fimEscalaMs - margemSeg * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// DESLOCAMENTO PARA A BASE — pedido do José em 09/09/2026
//
// "adicionar uma coluna com o horário e o tempo do último deslocamento para a
// base".
//
// ⚠️ NÃO EXISTE DADO DE BASE NO SISTEMA. Verificado: os checkpoints
// documentados são 0..4 e TODOS pertencem a uma nota
// (`docs/handoff/API-WPA-EDP.md`); não há evento de retorno, e não há
// localização de base em `equipes_oficiais` nem em lugar nenhum.
//
// A régua foi ESCOLHIDA pelo José entre três candidatas (spec §20):
//   **do fim do trabalho da última nota até o logoff.**
// A leitura operacional: a equipe fecha a última nota, dirige de volta e
// desloga na base. Não é medição de GPS — é inferência a partir de dois
// instantes que temos, e a spec registra isso pra ninguém tratar como
// deslocamento medido.
// ─────────────────────────────────────────────────────────────────────────────

/** Checkpoint 3 = Fim do Trabalho (docs/handoff/API-WPA-EDP.md §297). */
const EVENT_FIM_TRABALHO = 3;

/**
 * FUNÇÃO PURA (testável): quando o trabalho na nota terminou de fato.
 *
 * Devolve o **ÚLTIMO** `event = 3`. É assimétrico em relação a
 * `inicioDeslocamento` (que pega o PRIMEIRO `event = 0`), e de propósito: lá a
 * pergunta é "quando foi despachada?", que é o primeiro despacho; aqui é
 * "quando terminou?", que é o último fim. Usar o primeiro `3` numa nota com
 * várias tentativas encurtaria o trabalho e alongaria a viagem de volta.
 */
function fimTrabalho(checkpoints) {
  let maior = null;
  for (const cp of (checkpoints || [])) {
    if (!cp || Number(cp.event) !== EVENT_FIM_TRABALHO) continue;
    const ms = msParede(cp.registradoEm);
    if (ms == null) continue;
    if (maior == null || ms > maior) maior = ms;
  }
  return maior;
}

/**
 * FUNÇÃO PURA (testável): a volta pra base, inferida.
 *
 * Começa no fim do trabalho da última nota e termina no logoff.
 *
 * Devolve **null** quando:
 *   • falta uma das pontas (sem checkpoint, ou sessão ainda aberta);
 *   • o logoff é ANTERIOR ao fim do trabalho. Isso é impossível na operação —
 *     ou o dado está inconsistente, ou a "última nota" não é a que fecha o
 *     dia. Devolver duração negativa, ou zerar, seria inventar; null diz que
 *     não dá pra afirmar.
 */
function deslocBase(fimTrabalhoMs, fimSessaoMs) {
  if (fimTrabalhoMs == null || fimSessaoMs == null) return null;
  if (!Number.isFinite(fimTrabalhoMs) || !Number.isFinite(fimSessaoMs)) return null;
  const duracaoMs = fimSessaoMs - fimTrabalhoMs;
  if (duracaoMs < 0) return null;
  return { inicioMs: fimTrabalhoMs, duracaoMs, duracaoMin: Math.round(duracaoMs / 60000) };
}

/** FUNÇÃO PURA: ms de parede → 'YYYY-MM-DD HH:MM:SS' pra planilha. */
function fmtParede(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * FUNÇÃO PURA (testável): monta a linha da planilha.
 *
 * Recebe tudo resolvido. Devolve as colunas A..Q da spec §3; as de parecer
 * (R..Y) são preenchidas por humano e nem existem aqui.
 */
function montarLinhaHe({ equipe, dia, cadastro, janela, sessao, he, valorHora, ultima, qtd }) {
  const c = cadastro || {};
  return {
    equipe,
    servico:        c.servico || null,
    cidade:         c.cidade || null,
    regional:       c.regional || null,
    tipo_breve:     c.tipo_breve || null,
    he_revisado:    !!c.he_revisado,
    ultima_nota:    ultima ? rotuloUltimaNota(ultima.nota) : null,
    ultima_nota_em: ultima ? fmtParede(ultima.conclusaoMs) : null,
    qtd:            qtd == null ? null : Number(qtd),
    valor_hora:     valorHora == null ? null : Number(valorHora),
    inicio_escala:  fmtParede(janela.inicioMs),
    inicio_sessao:  fmtParede(sessao.inicioMs),
    antecipacao_h:  he.antecipacao_h,
    fim_escala:     fmtParede(janela.fimMs),
    fim_sessao:     fmtParede(sessao.fimMs),
    prorrogacao_h:  he.prorrogacao_h,
    total_dec:      he.total_dec,
    total_min:      he.total_min,
    data:           dia,
    valor_total:    valorTotalHe(he.total_h, valorHora),
    // Metadados que não vão pra planilha, mas a tela usa pra avisar.
    // Regra do acordo 30 min — preenchidas depois, quando os checkpoints da
    // última nota são lidos em lote (ver `_aplicarAcordo30`).
    desloc_ultima_nota: null,
    acordo_30:          null,
    desloc_base_em:     null,
    desloc_base_min:    null,
    _total_h:       he.total_h,
    _incompleta:    he.incompleta,
    _relogins:      sessao.relogins,
    // ms do fim da escala, pra comparar com o início do deslocamento sem
    // reparsear a string formatada.
    _fim_escala_ms: janela.fimMs,
    _fim_sessao_ms: sessao.fimMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura do banco
// ─────────────────────────────────────────────────────────────────────────────

const _COLS_HE = 'cidade, tipo_breve, servico, he_revisado';

/**
 * FUNÇÃO PURA (testável): o tipo de turma que dita o valor/hora da equipe.
 *
 * Ordem: `tipo_breve` (a coluna criada pra isso) e, se estiver vazia, a coluna
 * `tipo` que já existia.
 *
 * ⚠️ POR QUE O FALLBACK EXISTE. Em 09/09/2026 o José preencheu o tipo de turma
 * direto na coluna `tipo` pela tela do Admin, antes de a migration ter rodado.
 * O trabalho está feito e é correto — então a medição usa. Mas o fallback só
 * aceita valor que seja um dos 6 do contrato: `tipo` também guarda
 * 'PLANTAO', 'COMERCIAL', 'BTZERO', 'USO MUTUO'…, e nenhum desses é tipo de
 * hora extra. Aceitar qualquer coisa aqui seria escolher um preço no chute.
 *
 * ⚠️ `tipo` NÃO é campo livre: ele alimenta o breakdown por tipo do Monitor
 * (`db/escalaQueries.js:168`) e, funcionalmente, a exclusão da equipe de
 * USO MUTUO do alerta de offline (`public/index.html:8012`). Se algum dia os
 * dois usos divergirem, `tipo_breve` é o lugar certo pro tipo de HE.
 */
function tipoHeDaEquipe(cad) {
  if (!cad) return null;
  const norm = v => (v == null ? null : String(v).toUpperCase().trim());
  const tb = norm(cad.tipo_breve);
  if (tb && TIPOS_BREVE.includes(tb)) return tb;
  const t = norm(cad.tipo);
  return t && TIPOS_BREVE.includes(t) ? t : null;
}

/**
 * Cadastro HE por equipe. Fallback pro schema sem as colunas novas, no molde
 * de `services/equipesOficiais.js:219/226`: consultar antes de rodar
 * `scripts/migrar-he-cadastro.js` não pode derrubar a tela.
 */
async function _cadastroEquipes(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT upper(btrim(sigla)) AS sigla, regional, tipo, ${_COLS_HE}
         FROM public.equipes_oficiais WHERE ativo`);
    return { mapa: new Map(rows.map(r => [r.sigla, r])), temCadastro: true };
  } catch (err) {
    if (!/column .* does not exist|undefined column/i.test(err.message || '')) throw err;
    console.warn('[he] cadastro HE ausente no schema — '
      + 'rode scripts/migrar-he-cadastro.js --apply');
    const { rows } = await pool.query(
      `SELECT upper(btrim(sigla)) AS sigla, regional, tipo
         FROM public.equipes_oficiais WHERE ativo`);
    return { mapa: new Map(rows.map(r => [r.sigla, r])), temCadastro: false };
  }
}

/**
 * Valores/hora do `app_settings`; cai no seed se a chave não existir.
 *
 * ⚠️ A coluna é `data`, não `value`. A 1ª versão lia `value`, o SELECT
 * estourava, o catch engolia e a tela mostrava "Valores/hora vindos do seed do
 * código" — que é justamente o aviso que existe pra esse caso, e foi o que
 * revelou o erro em 09/09/2026. O nome certo está em `db/schema-atual.sql:29`
 * e nos dois usos que já existiam (`db/queries.js:988` e
 * `db/deslocamentosQueries.js:123`).
 */
async function _valoresHora(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT data FROM public.app_settings WHERE key = 'he-valores-hora'`);
    const v = rows[0] && rows[0].data;
    const obj = typeof v === 'string' ? JSON.parse(v) : v;
    if (obj && typeof obj === 'object') {
      // Só os tipos do contrato, e só número positivo — chave estranha no
      // app_settings não pode virar valor de fatura.
      const limpo = {};
      for (const t of TIPOS_BREVE) {
        const n = Number(obj[t]);
        if (Number.isFinite(n) && n > 0) limpo[t] = n;
      }
      if (Object.keys(limpo).length) return { valores: limpo, origem: 'app_settings' };
    }
  } catch (err) {
    console.warn('[he] app_settings.he-valores-hora ilegível:', err.message);
  }
  return { valores: { ...VALORES_HORA_SEED }, origem: 'seed' };
}

/**
 * Preenche `desloc_ultima_nota` e `acordo_30` nas linhas, em LOTE.
 *
 * Uma consulta só pros checkpoints de todas as últimas notas do período — 400
 * consultas dentro do laço custariam mais que a medição inteira.
 *
 * Cobertura não é garantida: `note_details` é populada por cron e nota antiga
 * pode não estar lá. Sem checkpoint, `acordo_30` fica **null** (não sei), nunca
 * false (conferi e não cumpre) — ver `acordo30`.
 */
async function _aplicarAcordo30(pool, linhas) {
  const ids = [...new Set(linhas.map(l => l._ultima_note_id).filter(Boolean))];
  if (!ids.length) return { comCheckpoint: 0, semDetalhe: linhas.length };

  let porId = new Map();
  try {
    const { rows } = await pool.query(
      `SELECT note_id::text AS id, payload->'checkpoints' AS cps
         FROM public.note_details
        WHERE note_id = ANY($1::uuid[])`, [ids]);
    porId = new Map(rows.map(r => [r.id, r.cps]));
  } catch (err) {
    // Falta de detalhe é degradação, não erro: a medição segue sem as duas
    // colunas novas em vez de não sair.
    console.warn('[he] checkpoints da última nota indisponíveis:', err.message);
    return { comCheckpoint: 0, semDetalhe: linhas.length };
  }

  let comCheckpoint = 0, semDetalhe = 0;
  for (const l of linhas) {
    const cps = l._ultima_note_id ? porId.get(l._ultima_note_id) : null;
    if (!cps) { semDetalhe++; continue; }
    comCheckpoint++;

    // Regra 1 — acordo 30 min.
    const iniMs = inicioDeslocamento(cps);
    if (iniMs != null) {
      l.desloc_ultima_nota = fmtParede(iniMs);
      l.acordo_30 = acordo30(iniMs, l._fim_escala_ms);
    }

    // Regra 2 — volta pra base: fim do trabalho da última nota → logoff.
    // Régua escolhida pelo José em 09/09/2026 entre três candidatas (spec §20).
    const volta = deslocBase(fimTrabalho(cps), l._fim_sessao_ms);
    if (volta) {
      l.desloc_base_em  = fmtParede(volta.inicioMs);
      l.desloc_base_min = volta.duracaoMin;
    }

  }
  return { comCheckpoint, semDetalhe };
}

function _diaMais(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Medição HE do período.
 *
 * @param {string} de   'YYYY-MM-DD'
 * @param {string} ate  'YYYY-MM-DD'
 * @param {object} opts { regionais?: string[], teams?: string[] }
 */
async function medicaoHe(de, ate, opts = {}) {
  const pool = _getPool();
  const { mapa: cadastro, temCadastro } = await _cadastroEquipes(pool);
  const { valores, origem: origemValores } = await _valoresHora(pool);

  // ── Escala do período ─────────────────────────────────────────────────────
  // `escala_dia` é por colaborador; agrupa em (dia, equipe, janela) distinta.
  const { rows: escRows } = await pool.query(
    `SELECT to_char(ed.data, 'YYYY-MM-DD')      AS dia,
            upper(btrim(ed.equipe))             AS equipe,
            ec.inicio_escala, ec.fim_escala
       FROM public.escala_dia ed
       JOIN public.escalas_catalogo ec
         ON ec.codigo = ed.codigo_escala AND ec.sector_id = ed.sector_id
      WHERE ed.data BETWEEN $1::date AND $2::date
        AND ec.inicio_escala IS NOT NULL
        AND ec.fim_escala    IS NOT NULL
      GROUP BY 1, 2, 3, 4`, [de, ate]);

  const escalaPorChave = new Map();     // 'equipe|dia' → [{inicio_escala, fim_escala}]
  for (const r of escRows) {
    const k = `${r.equipe}|${r.dia}`;
    if (!escalaPorChave.has(k)) escalaPorChave.set(k, []);
    escalaPorChave.get(k).push(r);
  }

  // ── Sessões ───────────────────────────────────────────────────────────────
  // ⚠️ LOOKAHEAD DE +1 DIA. A sessão que fecha depois da meia-noite tem o
  // logoff gravado num snapshot do dia SEGUINTE (`EBGPR64`, 24/07 → 25/07
  // 00:02). Sem expandir o range, a prorrogação de 7h desaparece.
  // Mesma regra de `db/queries.js:341` e do consolidateDay.
  //
  // DISTINCT ON (equipe, session_begin) + captured_at DESC = o último estado
  // conhecido de cada sessão, que é onde o `session_end` final vive.
  //
  // ⚠️ O LOGOFF PODE ESTAR SÓ NO JSONB — e por isso o COALESCE.
  //
  // `dataWriter.saveSnapshot` (`services/dataWriter.js:48`) grava a coluna
  // `session_end` no momento do snapshot. Mas o job `runSyncLogoffs`, das
  // 03:00 (`services/cronService.js:1619`), que existe justamente pra pegar o
  // logoff de quem saiu DEPOIS do último snapshot do dia, atualiza apenas o
  // payload: `update({ data: newData })`. A coluna fica NULL.
  //
  // Consequência medida em 09/09/2026: 277 de 2.137 sessões (13%) apareciam
  // como ABERTAS na medição — quase todas de PLANTÃO (`EP*`), com login à
  // tarde/noite e último snapshot sempre às 23:45. Não eram sessões abertas
  // nem abandonadas: eram TURNOS NOTURNOS cujo logoff o job das 03:00 gravou
  // no jsonb. Ler só a coluna subnotificava a prorrogação de todo turno que
  // atravessa a meia-noite.
  //
  // O código antigo do painel (`db/queries.js:402`) sempre leu do payload; eu
  // preferi a coluna por ser indexada, e ela é justamente a que o back-fill
  // não mantém. As duas grafias entram no COALESCE porque `cronService` aceita
  // ambas ao ler.
  const { rows: sesRows } = await pool.query(
    `SELECT DISTINCT ON (team_name, session_begin)
            upper(btrim(team_name)) AS equipe, regional, session_begin,
            COALESCE(session_end, data->>'sessionEnd', data->>'session_end') AS session_end,
            concluidas, executadas, data
       FROM public.snapshots
      WHERE date BETWEEN $1::date AND $2::date
        AND session_begin IS NOT NULL
      ORDER BY team_name, session_begin, captured_at DESC`,
    [de, _diaMais(ate, 1)]);

  // A sessão pertence ao dia do seu session_begin, não ao dia do snapshot —
  // regra já usada em `db/queries.js:377`.
  const sessoesPorChave = new Map();
  for (const r of sesRows) {
    const dia = String(r.session_begin).slice(0, 10);
    if (dia < de || dia > ate) continue;
    const k = `${r.equipe}|${dia}`;
    if (!sessoesPorChave.has(k)) sessoesPorChave.set(k, []);
    sessoesPorChave.get(k).push(r);
  }

  // ── Montagem ──────────────────────────────────────────────────────────────
  const filtroReg  = Array.isArray(opts.regionais) && opts.regionais.length
    ? new Set(opts.regionais) : null;
  const filtroTeam = Array.isArray(opts.teams) && opts.teams.length
    ? new Set(opts.teams.map(t => String(t).toUpperCase())) : null;

  const linhas = [];
  const semCadastro = new Set();
  const naoRevisadas = new Set();
  let semEscala = 0;
  // Linhas com hora extra REAL mas abaixo do piso de 1 min (ver PISO_HE_SEG).
  // Contadas pra que o descarte apareça: sumir com linha em silêncio viraria
  // "faltam linhas" na conferência da Fase 4, sem ninguém saber por quê.
  const descartadas = { linhas: 0, minutos: 0, valor: 0 };

  for (const [chave, sessoes] of sessoesPorChave) {
    const [equipe, dia] = chave.split('|');
    if (filtroTeam && !filtroTeam.has(equipe)) continue;

    const cad = cadastro.get(equipe) || null;
    const reg = (cad && cad.regional) || sessoes[0].regional || null;
    if (filtroReg && !filtroReg.has(reg)) continue;

    const pares = escalaPorChave.get(chave);
    // Sem escala não há como medir extrapolação — não é hora extra zero, é
    // desconhecida. Conta pra avisar (cruza com o P2-47).
    if (!pares || !pares.length) { semEscala++; continue; }

    const janela = janelaMaisAmpla(dia, pares);
    if (!janela) { semEscala++; continue; }

    const sessao = sessaoDoDia(sessoes.map(s => ({ begin: s.session_begin, end: s.session_end })));
    if (!sessao) continue;

    const he = calcularHe(janela, sessao);

    // Tipo e preço resolvidos ANTES do piso, pra poder dizer quanto foi
    // descartado em reais. Descarte silencioso viraria "sumiram linhas" na
    // conferência da Fase 4.
    const tipoHe = tipoHeDaEquipe(cad);
    const valorHora = tipoHe ? (valores[tipoHe] ?? null) : null;

    if (!temHe(he)) {
      // Distingue "não houve hora extra" (o dia normal, não interessa) de
      // "houve, mas abaixo do piso de 1 min" (informação: é o ruído que o
      // piso existe pra tirar, e o gestor tem direito de saber o tamanho).
      if (he && ((he.antecipacao_h > 0) || (he.prorrogacao_h > 0))) {
        descartadas.linhas++;
        descartadas.minutos += he.total_ms / 60000;
        descartadas.valor   += valorTotalHe(he.total_h, valorHora) || 0;
      }
      continue;
    }

    // O snapshot da sessão mais recente é o que carrega o estado final do dia.
    const ultimoSnap = sessoes
      .slice()
      .sort((a, b) => String(a.session_begin).localeCompare(String(b.session_begin)))
      .pop();

    // QTD: `concluidas`. A medição é sempre retrospectiva, e no histórico
    // `notasExecutadas` vem vazio de propósito (ver wpaService.js:1678), então
    // `executadas` não serve pra mês fechado. `_qtd_executadas` segue no
    // objeto pra Fase 4 conferir se a planilha usa a outra contagem.
    // `tipoHe` e `valorHora` foram resolvidos ANTES do piso — a linha mostra o
    // tipo RESOLVIDO, senão a tela diria "sem cadastro" numa equipe que tem
    // preço. Ver `tipoHeDaEquipe`.
    const linha = montarLinhaHe({
      equipe, dia,
      cadastro:  { ...(cad || {}), regional: reg, tipo_breve: tipoHe },
      janela, sessao, he,
      valorHora,
      ultima:    ultimaNotaDaSessao(ultimoSnap.data),
      qtd:       ultimoSnap.concluidas,
    });
    linha._qtd_executadas = ultimoSnap.executadas;
    // Guardado pra buscar os checkpoints em lote depois do laço.
    const _ult = ultimaNotaDaSessao(ultimoSnap.data);
    linha._ultima_note_id = (_ult && _ult.nota && _ult.nota.id) || null;
    linhas.push(linha);

    if (!tipoHe) semCadastro.add(equipe);
    else if (cad && cad.tipo_breve && !cad.he_revisado) naoRevisadas.add(equipe);
  }

  linhas.sort((a, b) => a.data.localeCompare(b.data) || a.equipe.localeCompare(b.equipe));

  // Regra do acordo 30 min (pedido do José, 09/09/2026) — em lote.
  const acordo = await _aplicarAcordo30(pool, linhas);

  const comValor    = linhas.filter(l => l.valor_total != null);
  const totalValor  = comValor.reduce((s, l) => s + l.valor_total, 0);
  const r2 = n => Math.round(n * 100) / 100;
  return {
    periodo: { de, ate },
    linhas,
    resumo: {
      linhas:        linhas.length,
      equipes:       new Set(linhas.map(l => l.equipe)).size,
      total_horas:   r2(linhas.reduce((s, l) => s + (l._total_h || 0), 0)),
      // Separados porque a Fase 4 precisa isolar exatamente a divergência
      // prevista: a planilha atual zera a antecipação, e o sistema mede.
      total_antecipacao_h: r2(linhas.reduce((s, l) => s + (l.antecipacao_h || 0), 0)),
      total_prorrogacao_h: r2(linhas.reduce((s, l) => s + (l.prorrogacao_h || 0), 0)),
      // ⚠️ Soma só do que TEM valor, e o contador do que não tem vem ao lado.
      // Sem `linhas_sem_valor`, um período em que NENHUMA linha tem cadastro
      // exibiria "R$ 0,00" — que se lê como "nada a cobrar" quando a verdade é
      // "não sei". Reportado em 09/09/2026 na 1ª abertura da tela.
      valor_total:      r2(totalValor),
      linhas_com_valor: comValor.length,
      linhas_sem_valor: linhas.length - comValor.length,
      incompletas:   linhas.filter(l => l._incompleta).length,
      com_relogin:   linhas.filter(l => l._relogins > 0).length,
      // O que o piso tirou. Aparece na tela e na aba PROCEDÊNCIA do XLSX.
      // Regra do acordo 30 min.
      acordo_margem_min:   ACORDO_MARGEM_SEG / 60,
      acordo_sim:          linhas.filter(l => l.acordo_30 === true).length,
      acordo_nao:          linhas.filter(l => l.acordo_30 === false).length,
      // Sem checkpoint da última nota — a condição NÃO foi avaliada. Separado
      // de `acordo_nao` de propósito: "não sei" não é "não cumpre".
      acordo_sem_dado:     linhas.filter(l => l.acordo_30 == null).length,
      // Volta pra base: quantas linhas puderam ser inferidas.
      base_com_dado:       linhas.filter(l => l.desloc_base_min != null).length,
      base_min_mediana:    (() => {
        const v = linhas.map(l => l.desloc_base_min).filter(n => n != null).sort((x, y) => x - y);
        return v.length ? v[Math.floor(v.length / 2)] : null;
      })(),
      piso_min:            PISO_HE_SEG / 60,
      descartadas_piso:    descartadas.linhas,
      descartadas_min:     r2(descartadas.minutos),
      descartadas_valor:   r2(descartadas.valor),
    },
    // Tudo que a tela precisa pra avisar em vez de exibir número falso.
    avisos: {
      sem_cadastro:      [...semCadastro].sort(),
      nao_revisadas:     [...naoRevisadas].sort(),
      dias_sem_escala:   semEscala,
      schema_sem_he:     !temCadastro,
      origem_valores:    origemValores,
    },
    // Procedência do preço, pro rodapé do XLSX (spec §2 — não há vigência
    // histórica no banco, então a planilha enviada é a evidência).
    valores_hora: valores,
    gerado_em: new Date().toISOString(),
  };
}

module.exports = {
  medicaoHe,
  // Puras, exportadas pra teste — é onde mora o erro de 3 horas e o de centavos.
  msParede,
  normHora,
  janelaDaEscala,
  janelaMaisAmpla,
  sessaoDoDia,
  calcularHe,
  valorTotalHe,
  temHe,
  PISO_HE_SEG,
  rotuloUltimaNota,
  ultimaNotaDaSessao,
  fmtParede,
  montarLinhaHe,
  tipoHeDaEquipe,
  inicioDeslocamento,
  acordo30,
  fimTrabalho,
  deslocBase,
  EVENT_FIM_TRABALHO,
  EVENT_INICIO_DESLOC,
  ACORDO_MARGEM_SEG,
};
