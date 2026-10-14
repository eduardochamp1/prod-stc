# SPEC — Alerta de baixa produtividade (balão de avisos, lado esquerdo)

> Data: 2026-10-14 · Pedido do José. Status: **desenhado, não implementado**.
> Brainstorm fechado em 14/10/2026. Nasce **desligado** (`ativo: false`) até o
> backtest (§9) ser lido pelo José.
>
> **Toca backend (avaliador + tabela + endpoint) e frontend (balão novo).** Não
> altera nenhuma agregação nem número reportado à EDP: o alerta só LÊ a produção.

## 1. Objetivo

Avisar supervisores/coordenadores quando uma equipe chega à **metade do turno**
com **menos de 4 notas executadas**, para que acompanhem de perto, cobrem ou
procurem saber o motivo.

Restrição de produto: usuários reclamam de **excesso de informação na tela**.
O aviso tem que ser **silencioso por padrão** — sem popup, sem modal, sem som.

## 2. Decisões (fechadas no brainstorm)

| # | Decisão | Escolha |
|---|---|---|
| D1 | Limite | **4 notas**, em configuração (não no código) |
| D2 | O que conta | **Só executadas não rejeitadas** (mesma regra do card "OS Executadas") |
| D3 | Contexto no alerta | Mostra também as **rejeitadas** da equipe no dia |
| D4 | Ação do supervisor | **Nenhuma.** Só avisa; o alerta some da lista quando a equipe chega ao limite |
| D5 | Categorias | **Comercial, Plantão, Moto, BT Zero.** Operacional fora. Lista em configuração |
| D6 | Onde roda | **Backend**, após cada ciclo de coleta. Rejeitada a abordagem "só no navegador" |
| D7 | Superfície | **Balão novo no lado ESQUERDO**, só de avisos. O balão de ações (borda direita, `SPEC-balao-acoes-rapidas`) **não é tocado** |
| D8 | Popup | **Não.** Contador no balão + contador no `<title>` da aba |
| D9 | Entrega ativa (Teams/e-mail) | **Fora desta spec** (fase 2) |

**Por que D8:** popup interrompe, e a queixa é justamente excesso de tela. O
`<title>` com contador (`(3) WPA Monitor`) avisa mesmo com a aba em segundo plano
sem competir com o que a pessoa está fazendo. O app também não tem toast hoje.

**Por que D7:** as ações (Atualizar, Acordar WPA) e os avisos são coisas
diferentes. Misturar mudaria a spec do balão atual (D1 dela) sem necessidade.

**Por que D9 fica fora:** as 5 contas do painel são **compartilhadas por região**
(a do ES vê GUA+CAC); não há login por supervisor. O alerta chega a quem abrir o
painel, filtrável por supervisor, e **não a uma pessoa específica**. Chegar à
pessoa exige contato de cada supervisor e passar pelo Fortinet.

## 3. A regra

Uma equipe gera alerta no dia D quando **todas** forem verdadeiras:

1. Está na whitelist (`equipes_oficiais`, ativa) e a categoria está em
   `config.categorias`.
2. Está **logada hoje** (sessão de hoje). Equipe deslogada NÃO gera alerta — é
   outro problema, coberto pelas telas de sessão/deslogadas.
3. `agora >= meio_turno` e `agora < escala_fim`.
   `meio_turno = (escala_inicio + escala_fim) / 2`. Ex.: Comercial 08–17 → 12:30.
4. `executadas < config.limite`, onde `executadas` = concluídas **não rejeitadas**
   do dia (rejeitada > concluída, decisão 20/07/2026; regra de 31/07 para
   rejeição posterior).
5. **Não** está em refeição neste ciclo. Em refeição, o alerta **espera o ciclo
   seguinte** (até `config.tolerancia_refeicao_min`; passado esse prazo avalia
   mesmo assim — equipe que "almoça" por mais de 1h também é informação).

**Um alerta por equipe por dia.** Se depois a equipe chegar a `limite`, o alerta
é marcado como **resolvido** (sai da lista, fica no registro) e **não volta a
disparar** no mesmo dia.

### Casos de borda (têm teste)

- Turno que **atravessa a meia-noite** (`escala_fim < escala_inicio`): o meio do
  turno e o "dia" do alerta usam o `_effDate` (reconexão vira-noite, P1-14), não
  o dia civil.
- Equipe **sem escala** (P2-47: 10 equipes da whitelist não estão na escala do
  SGE): cai no default por prefixo da sigla (o mesmo da migration
  `add_escala_equipes.sql`). Se nem isso houver, **não avalia** (nunca inventa).
- `executadas` **cai** depois do disparo (nota concluída vira rejeitada): o
  alerta pode ABRIR em ciclo posterior; não reabre um resolvido.
- Dia sem nenhuma equipe avaliável → lista vazia, sem erro.

## 4. Configuração

`app_settings`, chave `alerta_produtividade` (mesmo padrão de `metas_diarias`):

```json
{
  "ativo": false,
  "limite": 4,
  "categorias": ["COMERCIAL", "PLANTAO", "MOTO", "BT_ZERO"],
  "tolerancia_refeicao_min": 60
}
```

- Ausente ou ilegível → **tudo desligado** (`ativo:false`). Nunca assume ligado.
- Edição: `PUT /admin/alertas/config` (só admin), validado (limite inteiro ≥ 1,
  categorias dentro de `CATEGORIAS`). **Sem tela de edição nesta spec**; até lá,
  edita-se por script/psql.

## 5. Dados

Migration `migrations/add_alertas_produtividade.sql` — **tabela nova precisa de
`OWNER TO wpa_app`** (aprendizado do incidente de 07/10: migration pendente
trancou o login; aplicar ANTES do deploy do código).

```
alertas_produtividade
  id               bigserial PK
  data             date        not null      -- dia BRT (_effDate)
  team_name        text        not null
  regional         text        not null
  sector_id        text
  supervisor       text                      -- supervisor VIGENTE no dia (supervisorVigente)
  limite           int         not null      -- limite em vigor no disparo
  meio_turno_em    timestamptz not null
  executadas_disparo int       not null
  executadas_atual   int       not null      -- atualizada a cada ciclo enquanto aberto
  rejeitadas       int         not null default 0
  disparado_em     timestamptz not null
  resolvido_em     timestamptz
  UNIQUE (data, team_name)                   -- idempotência: 1 alerta/equipe/dia
```

Escrita **idempotente** (princípio do projeto): disparo é
`INSERT … ON CONFLICT (data, team_name) DO NOTHING`; o ciclo seguinte só
**atualiza** `executadas_atual`/`rejeitadas`/`resolvido_em`. Reexecutar um ciclo
não duplica nem reabre.

## 6. Backend

| Unidade | Papel | Depende de |
|---|---|---|
| `services/alertaProdutividade.js` — `avaliarEquipe(entrada)` | **Função PURA**: devolve `{ estado: 'nenhum'\|'abrir'\|'manter'\|'resolver', ... }` | só dados passados |
| `services/alertaProdutividade.js` — `meioDoTurno(inicio, fim)` | **Pura**: horário do meio, tratando virada de meia-noite | — |
| `services/alertaProdutividade.js` — `avaliarCiclo(deps)` | Orquestra: lê equipes ao vivo, escala, supervisor, config; chama `avaliarEquipe`; grava | deps **injetadas** |
| `db/alertasQueries.js` | `upsertAbrir`, `atualizar`, `resolver`, `listarAtivos(regionais)` | pgShim |
| `routes/index.js` | `GET /api/alertas/produtividade` (escopo `req.scope.regionals`), `PUT /admin/alertas/config` | auth existente |
| `services/cronService.js` | chama `avaliarCiclo` ao fim do ciclo de coleta, em `try/catch` | — |

**Por que `deps` injetadas:** o backlog P2-39 documenta que funções de cron são
**invisíveis à suíte** (saem cedo sem banco; erro de escopo só estoura em
produção, na hora agendada). `avaliarCiclo` recebe leitor/gravador/relógio por
parâmetro, então o teste a exercita de ponta a ponta com dados falsos.

**Fonte de `executadas`:** a MESMA função que o resto do sistema usa para a
produção do dia (`_notasConcluidasReais` / regra de `upsertSubcatTotals`). Fonte
única por métrica — **proibido** recontar por outro caminho.

**Instâncias = 1** (regra 8 do CLAUDE.md): nenhum estado novo em memória do
processo; o estado vive na tabela.

## 7. Frontend

- Bloco novo, **irmão dos `.tab-panel`**, `position: fixed` na **borda esquerda**
  (aparece nas 9 abas sem repetir markup — mesmo raciocínio da spec do balão).
- Fechado: círculo com 🔔 e **contador** (oculto quando 0). Aberto: painel curto.
- Cada linha: `ECXXX00 · GUA · Sup. FULANO` e abaixo
  `2 executadas (+1 rejeitada) às 12:30 · turno 08–17h`. Ordenação: menos
  executadas primeiro, depois mais antigo.
- Vazio: `Nenhum alerta agora.`
- Filtro por **supervisor**, reaproveitando `_supPopularSelect`. Escopo por
  regional vem do servidor (a conta só recebe o que pode ver).
- Contador também no `document.title` (`(3) WPA Monitor`); some quando 0.
- Atualização: no mesmo ciclo de refresh das abas + ao abrir o painel. Sem
  `setInterval` próprio.
- Acessibilidade: `aria-live="polite"` no contador, ESC fecha e devolve o foco ao
  toggle (padrão do balão de ações).
- **Sem** popup, modal, toast ou som.

Todo texto vindo do banco (sigla, supervisor) passa por `escapeHtml` /
`escapeJsAttr` — o commit 684d277 (`escapeJsAttr` nos `onclick` com dado da EDP)
mostrou que atributo com dado externo é vetor.

## 8. Erros

- Falha de config/banco/avaliação → `log.warn` + **nenhum alerta novo**; a lista
  mostra o que já estava gravado. Nunca fabrica número.
- Falha do endpoint no front → balão mostra `Avisos indisponíveis`, sem derrubar
  a aba.
- `ativo:false` → endpoint devolve lista vazia e o balão **nem aparece**.

## 9. Testes e rollout

**Testes** (`node --test`, função pura primeiro):

- limite exato (3 → alerta; 4 → não); `limite` configurável;
- meio do turno: 08–17 → 12:30; **virada de meia-noite**; sem escala → default
  por prefixo; sem nada → não avalia;
- executadas **exclui rejeitadas**; rejeitadas aparecem só como contexto;
- refeição **adia**; passada a tolerância, avalia;
- deslogada e categoria desligada **não** alertam;
- resolve ao chegar a `limite` e **não reabre**; 1 por equipe por dia;
- `avaliarCiclo` com `deps` falsas: idempotente em 2 execuções;
- endpoint respeita o escopo de regional; `ativo:false` → vazio;
- front (estilo `test/remotasNaII.test.js`): balão no DOM, contador no
  `<title>`, texto escapado.

**Backtest antes de ligar** — `scripts/backtest-alerta-produtividade.js`:
reaplica a regra sobre os **últimos 30 dias de snapshots** (retenção ilimitada) e
imprime, por dia e por categoria, quantas equipes teriam alertado e a
distribuição de `executadas` no meio do turno. **Critério de parada:** se a regra
alertaria uma fração alta e constante das equipes (ordem de dezenas de %), o
limite ou a regra estão errados — **não ligar**, rediscutir com o José.

**Ordem de deploy:** (1) migration; (2) código com `ativo:false`; (3) rodar o
backtest na VM; (4) José lê e decide; (5) `ativo:true`.

**Rollback:** `ativo:false` desliga tudo na hora, sem deploy. A tabela pode ficar.

## 10. Verificações pendentes (resolver no plano, antes de codar)

1. **Sinal de refeição ao vivo.** Confirmar se o dado da equipe em memória indica
   "em refeição" (status/desvio). Se não indicar, alternativas: `getSessionBreaks`
   (custo: 1 chamada por equipe) ou adiar por horário fixo. **Não** assumir.
2. **Qualidade da escala.** `escala_inicio/fim` têm default por prefixo (turno de
   9h = 8h + 1h de refeição). Medir quantas equipes têm escala real do SGE vs
   default — afeta a exatidão do "meio do turno".
3. **Fuso.** `escala_*` é `TIME` sem zona (BRT). Garantir a comparação em BRT
   (ver P1-48/P3-12: `_hojeBRT` com `-3h` fixo ainda vive em 5 lugares).

## 11. Fora de escopo (v1)

- Ação do supervisor ("acompanhando", motivo) — D4; reavaliar após ver o ruído.
- Teams/e-mail/WhatsApp — D9.
- Tela de edição da configuração.
- Outros tipos de alerta (equipe parada, sessão anômala etc.). A tabela tem o
  nome `alertas_produtividade` de propósito; um catálogo geral de notificações
  só se justifica quando houver o segundo tipo (YAGNI).
- Peso por tipo de nota (SF é rápida, DD/MD demoradas). O limite é por **nota**;
  se o backtest mostrar viés por categoria, vira item próprio.
