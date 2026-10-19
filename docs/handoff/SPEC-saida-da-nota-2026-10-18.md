# SPEC — Saída da nota (aba que substitui o Ranking)

> Data: 2026-10-18 · Pedido do José. Status: **especificado, nada implementado** (backlog **P2-70**).
> A regra foi calibrada em 6 rodadas de backtest na VM (11–17/10/2026) com
> `scripts/diag-saida-nota.js` e a lógica pura de `services/saidaNota.js`
> (commits e74f935 → c7bd57e). A aba usa **essas mesmas funções**: o que foi
> medido é o que vai ao ar.
>
> Só LÊ dados (WPA já coletado + rastreador do gseq). **Não altera nenhuma
> agregação nem número reportado à EDP.**

## 1. Objetivo

Mostrar à gestão as notas em que a equipe **apontou no WPA que estava executando
a nota e o veículo saiu do local** enquanto isso. É o "deslocamento dentro da
nota" do pedido de 18/10/2026:

> *"quando uma equipe faz o apontamento que está executando uma nota e desloca
> grandes distâncias enquanto deveria estar executando essa nota."*

Mais um segundo sinal que o backtest revelou, mais forte que o primeiro: a nota
**executada longe do local** (tablet e veículo longe da nota já no início do
trabalho).

A aba é de **triagem**: aponta casos para alguém conferir. Não pune nem conclui
nada sozinha (há saídas legítimas — §11).

## 2. Decisões

### 2.1 Fechadas com o José

| # | Decisão | Escolha |
|---|---|---|
| D1 | Onde fica | **Substitui a aba Ranking** |
| D2 | Plantão | Equipe **EP em nota PO** percorre a rede atrás do defeito: sair do local **é o serviço**. Fora da conta (status `patrulha`) |
| D3 | OS | Nota **OS** (numeração 1127…, SJC) tratada como patrulha **para qualquer equipe** — o José "acredita que sim" seja emergência. **Hipótese**, não confirmada (§13, Q2) |
| D4 | Placa da equipe | **Só o cadastro do gseq** (Veículos → Equipes × Veículos, tabela `equipes_veiculos`). A placa da sessão do WPA **não é usada**. A operação vai cadastrar |
| D5 | Equipes ET | "Deveriam ter rastreador, mas muitas ou quase todas não têm hoje". A aba **mostra a falta de cobertura**; nota sem rastreador **nunca** conta como "não saiu" |

**Por que D4 importa:** na semana medida, a placa da sessão do WPA estava errada
em **74 de 131 equipes** (`scripts/diag-sugere-placa.js`, 26 com sugestão
forte) — boa parte por uma troca de frota (série TDY-1C60…1C73) que o WPA não
acompanhou. Com D4, a qualidade da aba depende do cadastro: **no dia em que for
ao ar, cobre só as equipes cadastradas** (§9.3 dá à operação a lista do que falta).

### 2.2 Adotadas por mim (o José pode vetar)

| # | Decisão | Motivo |
|---|---|---|
| A1 | Raio **500 m**, mínimo **15 min** fora | 300 m fica no p95 do ruído (veículo × tablet no início p95 355 m; cadastro × início p95 335 m) — 1 nota em 20 seria marcada só por imprecisão. Ver §10 |
| A2 | Calculado **à noite, para D-1** (não ao vivo) | Precisa da pausa apontada (`sessao_intervalo`), que só é coletada às 03:10 para D-1, e do Fim do Trabalho. Ao vivo é fase 2 (§12) |
| A3 | Resultado **gravado para sempre** em tabela própria | A trilha do gseq é apagada com **60 dias** (`git/gseq/scripts/prune-vehicle-positions.js`). Sem gravar, o número de um mês atrás não se reproduz — e a EDP audita |
| A4 | Notas executadas **juntas** (mesma equipe, janelas que se sobrepõem) viram **uma ocorrência com N notas** | 5º backtest: EPPIU31 executou SO + SM no mesmo intervalo e a mesma saída contou duas vezes |
| A5 | Parâmetros em `app_settings` (chave `saida_nota`), editáveis por admin, com o padrão desta spec | Recalibrar não exige deploy; mesmo padrão do alerta de produtividade (P2-63) |
| A6 | **Sem mapa de fundo na v1**: a trilha vira link para o mapa externo + linha do tempo | Os tiles do OSM estão bloqueados (P2-59). Quando o P2-59 sair, o mapa entra |
| A7 | Mostrar, no painel de cobertura, a **placa que o rastreador sugere** para quem está sem cadastro | Só exibição, para a operação cadastrar mais rápido — **não** é usada no cálculo (respeita D4). Vetável |
| A8 | Leitura do gseq por um **papel só de leitura** | O WPA Monitor não deve poder escrever no banco de outro sistema |

## 3. A regra

Para cada **nota concluída** de equipe da whitelist (`equipes_oficiais`), no dia D:

1. **Janela de execução:** do **último** "Início do Trabalho" (checkpoint evento 2)
   ao "Fim do Trabalho" (evento 3) que vem depois dele; sem o 3, o último
   "Finalizando Trabalho" (evento 4). Instante = `RegisteredAt2` (o que o portal
   mostra), com fallback no `TimeStamp` — `janelaExecucao()`.
2. **Âncora (centro do raio):** coordenada **cadastrada pela EDP** na nota
   (`payload.endereco`, aceita UTM); sem ela, o GPS do tablet no início —
   `normalizaCoord()`, `ancoraDaNota()`. Medido: 99,9% das notas têm cadastro.
3. **Veículo:** placa de `equipes_veiculos` do gseq na data (correção do DIA
   vence VIGÊNCIA) — `placaGseqNaData()`. Sem cadastro → `sem_placa`.
4. **Trilha:** pontos do rastreador daquele veículo na janela. **A trilha do gseq
   só grava ponto quando o veículo muda** (posição > ~5 m ou ignição;
   `git/gseq/src/lib/tracking-fetch.ts`): silêncio = parado. Por isso o último
   ponto até **6h antes** do início vale como posição no início —
   `pontosNaJanela()`.
5. **Saída:** começa no 1º ponto fora do raio e termina no 1º ponto de volta (ou
   no fim da janela). Conta se durou **≥ 15 min** **e** teve **≥ 2 pontos fora,
   ou ignição ligada** (1 ponto fora com ignição desligada é salto de GPS) —
   `saidasDoRaio()`.
6. **Pausa apontada:** o tempo coberto por `sessao_intervalo` (refeição,
   retorno à base…) é descontado da saída; se sobrar menos de 15 min, a saída
   some — `descontarIntervalos()`. ⚠️ Fuso: hora de parede com 'Z' errado
   (P1-48); ler com `AT TIME ZONE 'UTC'`, como `db/heQueries.js:519-521`.
7. Classifica (§4).

## 4. Classificação de cada nota

Toda nota concluída recebe **exatamente um** status (aritmética por construção:
a soma dos status = notas concluídas do período).

| status | significado | entra em |
|---|---|---|
| `ok` | veículo ficou no local | avaliadas |
| `saiu` | começou no local e saiu (§3.5–3.6) | avaliadas · **indicador 1** |
| `saiu_em_intervalo` | saiu, mas coberto por pausa apontada | avaliadas |
| `longe_do_local` | veículo **e** tablet a mais de 500 m da nota no início | **indicador 2** |
| `fora_no_inicio` | veículo longe no início, tablet perto (foram a pé ou em outro carro) | cobertura |
| `patrulha` | EP em PO, ou OS (D2/D3) | fora da conta |
| `veiculo_divergente` | veículo do cadastro a > 5 km do tablet no início → **cadastro errado** | cobertura |
| `rastreador_fora` | frota inteira sem ponto > 20 min durante a execução | cobertura |
| `sem_trilha` | o veículo cadastrado não tem ponto nas 6h antes nem durante | cobertura |
| `sem_placa` | equipe sem placa cadastrada no gseq | cobertura |
| `sem_janela` | sem Início/Fim do Trabalho, ou sem detalhe da nota | cobertura |

Ordem de precedência na implementação: `sem_janela` → `sem_placa` → `sem_trilha`
→ `rastreador_fora` → `veiculo_divergente` → `patrulha` → (`longe_do_local` |
`fora_no_inicio` | `saiu` | `saiu_em_intervalo` | `ok`).

**Taxa de saída** = `saiu ÷ (ok + saiu + saiu_em_intervalo)`. Nunca sobre as
notas concluídas: sem rastreador não é "não saiu".

## 5. Fontes e acesso ao gseq

- **WPA Monitor (próprio banco):** `snapshots` (nota concluída → equipe),
  `note_details.payload` (checkpoints, endereço), `sessao_intervalo`,
  `equipes_oficiais`.
- **gseq (mesma VM, banco `gseq`):** `vehicle_positions` (`vehicle`, `lat`, `lon`,
  `ignition`, `eventAt`, `recordedAt`) e `equipes_veiculos`.
- **Acesso:** variável nova `GSEQ_DATABASE_URL` no `.env` do WPA Monitor, com um
  papel **só de leitura** (A8). Pré-requisito na VM, rodado pelo dono do banco
  gseq (**sem sudo**):
  ```sql
  CREATE ROLE wpa_leitura_gseq LOGIN PASSWORD '…';
  GRANT CONNECT ON DATABASE gseq TO wpa_leitura_gseq;
  GRANT SELECT ON vehicle_positions, equipes_veiculos TO wpa_leitura_gseq;
  ```
  Sem a variável, a aba mostra "rastreador não configurado" e o job não roda —
  nunca grava `ok` por falta de dado.
- **LGPD:** o nome da unidade no rastreador às vezes traz o motorista. Grava-se
  só a **placa**; nada de nome, CPF ou `Driver`.
- **Acoplamento:** o WPA Monitor passa a depender do gseq estar coletando. Já é
  coberto por `rastreador_fora`, e o job registra no log quantos veículos leu.

## 6. Processamento

- **Job noturno** `runSaidaNota(D-1)` às **04:30 BRT** em `services/cronService.js`
  (depois do `intervalosJob` das 03:10 e do `driftJob` das 02:00). Não chama a
  EDP.
- **Idempotente:** upsert por `note_id`; rodar de novo o mesmo dia substitui.
- **Retroativo:** `scripts/backfill-saida-nota.js --de --ate` (escreve só com
  `--apply`), limitado aos últimos 60 dias (retenção da trilha). Dá para
  reconstruir desde ~19/08/2026 no dia do deploy.
- **Recalcular depois de cadastrar placa:** o mesmo script, para o período
  afetado — o cadastro no gseq é por vigência, então a correção vale para trás.

## 7. Tabela `saida_nota` (migration 017)

| coluna | tipo | |
|---|---|---|
| `note_id` | `uuid PK` | |
| `data` | `date` | dia BRT do início da execução |
| `equipe`, `regional`, `numero`, `tipo` | `text` | |
| `status` | `text NOT NULL` | §4 |
| `placa`, `placa_fonte` | `text` | `gseq-dia` / `gseq-vigencia` |
| `inicio`, `fim` | `timestamptz` | janela de execução |
| `ancora_lat`, `ancora_lon`, `ancora_fonte` | | |
| `dist_max_m`, `min_fora`, `km` | `int`, `int`, `numeric` | |
| `saidas` | `jsonb` | `[{inicio, fim, minutos, dist_max_m}]` |
| `trilha` | `jsonb` | pontos da janela `{t, lat, lon, ign}` — guardados para a tela não depender do gseq depois dos 60 dias |
| `d_veiculo_tablet_m`, `d_cadastro_tablet_m`, `pausa_descontada_min` | `int` | |
| `ocorrencia_id` | `text` | agrupa notas executadas juntas (A4) |
| `regra_versao`, `calculado_em` | `text`, `timestamptz` | parâmetros usados — reprocessar com outra regra fica rastreável |

`OWNER wpa_app` (memória "tabela nova precisa de OWNER wpa_app"). Volume: ~1.000
linhas/dia; a `trilha` é o maior campo (dezenas de pontos por nota).

## 8. API

- `GET /api/saida-nota?de=&ate=&regionals=&supervisor=&prefixo=` → KPIs +
  ocorrências (`saiu` e `longe_do_local`), escopo por `req.scope.regionals`
  (lição do P1-12).
- `GET /api/saida-nota/cobertura?de=&ate=&regionals=` → por equipe: notas,
  avaliadas, e os motivos de não avaliar (§9.3).
- `GET /api/saida-nota/nota/:noteId` → detalhe: janela, saídas, trilha, pausas.
- As três entram no catálogo de rotas por aba do P0-1e quando ele for
  implementado (hoje a aba Ranking tem `/ranking/equipes` e `/carteira/equipes`).

## 9. Tela

### 9.1 Topo
Filtros (período, padrão últimos 7 dias até ontem; regional; supervisor; tipo de
equipe EC/EP/EB/ET) e quatro números:

- **Cobertura:** avaliadas ÷ concluídas (ex.: "17% das notas avaliadas") —
  **sempre visível**, para ninguém ler "poucas saídas" como "equipe comportada";
- **Saíram do local:** N ocorrências (taxa sobre avaliadas);
- **Executaram longe do local:** N;
- **Pausas descontadas:** N (transparência da regra).

### 9.2 Ocorrências
Tabela única com os dois indicadores, mais grave primeiro (minutos fora ×
distância): data, equipe, supervisor, nota(s), tipo, janela, minutos fora,
distância máxima, km rodados, indicador. Clique abre o detalhe: linha do tempo
(início, saída, volta, fim, pausas apontadas) e links "abrir no mapa" para a
nota e para o ponto mais longe (A6). Exportar XLSX (mesmo padrão das outras abas).

### 9.3 Cobertura (lista de trabalho para a operação)
Por equipe, quantas notas ficaram fora e por quê: **sem placa cadastrada**
(com a sugestão do rastreador, A7), **placa cadastrada não bate com o tablet**
(`veiculo_divergente`), **placa sem rastreador** (`sem_trilha`, caso das ET),
rastreador fora do ar. É o que diz à operação o que cadastrar ou corrigir.

## 10. Números do backtest (11–17/10/2026, placa ainda vinda do WPA)

6.344 notas concluídas. Avaliadas 1.104 (17%) com a placa do WPA.

| | |
|---|---|
| Saíram (500 m, 15 min) | **25 de 1.104 (2,3%)** — EC 16 de 977 (**1,6%**), EP 5 de 65, EB 4 de 49 |
| Distância máxima do local, avaliadas | p50 48 m · p90 440 m · p95 922 m |
| Veículo × tablet no início | p50 12 m · p95 355 m |
| Cadastro da nota × tablet no início | p50 20 m · p95 335 m |
| Hora em que a saída começou | 14 das 25 entre **11h e 13h** — nenhuma coberta por pausa apontada (§13, Q3) |
| Executou longe do local | casos de 0–1 min de execução a 8–61 km da nota com 0 km rodados (ex.: ECLSJ90, LN, 1 min, 61 km) |
| Grade, só EC | 300 m/15 min 1,8% · **500 m/15 min 1,6%** · 1 km/15 min 0,8% · 500 m/20 min 1,0% |

Volume esperado: **3 a 4 ocorrências por dia** com a cobertura de hoje; deve
dobrar quando o cadastro de placas cobrir as 26 equipes com sugestão forte
(~1.200 notas/semana a mais).

## 11. Limites conhecidos

- **Saída legítima existe:** buscar material, poste do outro lado do bairro,
  obra extensa. Por isso é triagem, com o caso aberto na tela.
- **Equipes sem rastreador (ET) ficam fora** até terem rastreador (D5).
- **Cadastro da nota errado** pode virar `longe_do_local` — o detalhe mostra a
  distância do tablet e do veículo para quem confere decidir.
- **Pausa não coletada:** se `sessao_intervalo` não tiver o dia, nada é
  descontado; o job registra "dia sem pausas coletadas" e a tela avisa.
- **OS como patrulha (D3) é hipótese:** se OS não for emergência, as saídas de
  OS estão sendo escondidas (§13, Q2).

## 12. Fora da v1

- **Ao vivo** ("executando a nota X e está a 5 km dela agora"), no Monitor.
- **Posição do tablet a cada 15 min** (`snapshots.data.location`, medida em
  18/10/2026 com ~60% das linhas preenchidas) como segunda fonte — confirma a
  trilha do rastreador e cobriria parte das ET.
- **Mapa** (depende do P2-59).

## 13. Perguntas em aberto

- ~~**Q1 — "Aproveitamento da Carteira"**~~ **respondida (José, 19/10/2026):**
  *"mova o Aproveitamento da Carteira (tabela + XLSX) para a aba Gráficos quando
  tirar o Ranking."* Hoje ele vive dentro da aba Ranking
  (`public/index.html:448-467`, JS em `:5730`) e herda o mês e a regional dos
  filtros do Ranking ("mesmo mês/regional do ranking acima"). Na mudança:
  - a seção vai para a aba Gráficos, com tabela e botão XLSX iguais;
  - passa a usar o período e a regional dos filtros da aba Gráficos — o
    `/carteira/equipes` já aceita `de`/`ate`, então o backend não muda;
  - no catálogo de rotas por aba do P0-1e, `/carteira/equipes` passa de
    `ranking` para `graficos`;
  - o mesmo commit que tira o Ranking move a seção (nunca um sem o outro).
- **Q2 — OS em SJC é mesmo emergência?** Confirmar com a operação de SJC. Se
  não for, sai da patrulha e a taxa das EC deve subir.
- **Q3 — Almoço:** nenhuma saída das 11h–13h foi coberta por pausa. Antes de ir
  ao ar, confirmar se `sessao_intervalo` tem as pausas dessas equipes (consulta
  em §16). Se tiver e em outro horário, é saída de verdade; se não tiver nada, é
  coleta ou as equipes não apontam a refeição.
- **Q4 — Quem vê a aba:** todos os logados (como o Ranking hoje) ou só admin
  até a primeira rodada de conferência?

## 14. Testes

- `services/saidaNota.js` já tem 27 testes (`test/saidaNota.test.js`); a v1
  acrescenta: `longe_do_local` × `fora_no_inicio`, agrupamento de notas
  simultâneas (A4), precedência de status (§4) e soma dos status = concluídas.
- Job: pool falso para os dois bancos (padrão do backtest); idempotência
  (rodar 2× = mesmas linhas).
- Rotas: escopo regional de ponta a ponta (padrão do P1-12).
- `scripts/diag-*` seguem só leitura (`test/diagSomenteLeitura.test.js`).

## 15. Aceite

- [ ] Ranking removido e o Aproveitamento da Carteira (tabela + XLSX) funcionando na aba Gráficos (Q1).
- [ ] `GSEQ_DATABASE_URL` com papel só de leitura na VM (§5).
- [ ] Migration 017 aplicada; job das 04:30 grava D-1; backfill dos 60 dias.
- [ ] Soma dos status = notas concluídas do período (teste + conferência na VM).
- [ ] Cobertura visível no topo; nota sem rastreador nunca conta como `ok`.
- [ ] 10 ocorrências conferidas com a operação antes de divulgar a aba.
- [ ] Equipes com sugestão forte cadastradas no gseq (ação da operação).

**Esforço:** 2–3 dias (job + tabela + rotas + tela), a regra já existe e está testada.

**Rollback:** remover a aba do `index.html` e desligar o job (`git revert`). A
tabela pode ficar. O Ranking volta pelo revert do commit que o tirou.

## 16. Comandos de conferência (VM)

```bash
# backtest com a regra desta spec
node scripts/diag-saida-nota.js --csv=/tmp/saida-nota.csv
# placa sugerida pelo rastreador, por equipe
node scripts/diag-sugere-placa.js --csv=/tmp/sugere-placa.csv
# Q3: as equipes que "saíram no almoço" apontaram a refeição?
psql -d wpa_monitor -c "SELECT upper(btrim(equipe)) AS equipe, motivo, to_char(inicio AT TIME ZONE 'UTC','DD/MM HH24:MI') AS inicio, to_char(fim AT TIME ZONE 'UTC','HH24:MI') AS fim FROM sessao_intervalo WHERE upper(btrim(equipe)) IN ('ECLSJ97','ECLSJ82','ECLJA72') AND data BETWEEN '2026-10-11' AND '2026-10-17' ORDER BY 1, 3"
```

⚠️ O backtest ainda usa a placa do WPA como reserva quando o gseq não tem
cadastro (cascata gseq → sessão do WPA → `equipes_oficiais`). A aba **não** (D4).
Ao implementar, o script ganha `--so-cadastro` para medir a cobertura real da aba.
⚠️ Também ainda não separa `longe_do_local` de `fora_no_inicio` nem agrupa notas
simultâneas (A4) — os dois entram junto com a v1.
