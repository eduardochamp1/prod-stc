# SPEC — Sub-aba "Medição HE" no Histórico

- **Data:** 09/09/2026
- **Pedido (José):** *"vamos criar uma sub aba em histórico, que seria a aba de
  medição HE. hoje ela é feita de forma manual baixando coisas de bi que
  traduzem as informações do wpa, outras coisas temos que procurar de forma
  manual no wpa. vamos otimizar e criar um local onde teremos essas informações
  já organizadas na ordem e que possamos baixar a planilha já pronta na ordem
  para analisar e enviar a edp."*
- **Status:** spec aprovada nas 4 decisões de escopo — **implementação não iniciada**
- **Fonte de referência:** `Medição Engelmig - CSD Guarapari (1).xlsx`, abas
  `DADOS`, `H.E STC-PLT`, `EQUIPES EXTRAS`, `Valores` (prints de 09/09/2026)

---

## 1. O que é a medição HE

Hora extra de equipe de campo, cobrada da EDP. Para cada (equipe, dia) em que a
sessão do app extrapolou a escala, mede-se quanto tempo passou, multiplica pelo
valor/hora do tipo da equipe, e a linha vai a parecer da Engelmig e depois da
EDP.

Hoje o levantamento é **manual**: BI para uns campos, busca no portal WPA para
outros. É trabalho de garimpo sobre dado que o WPA Monitor já ingere a cada
15 min.

---

## 2. Decisões de escopo (respondidas em 09/09/2026)

| # | Decisão | Escolha |
|---|---|---|
| 1 | Onde fica o cadastro que falta (cidade, tipo breve, PLT/STC) | **Colunas novas em `equipes_oficiais`** + edição na tela do Admin |
| 2 | Valores/hora por tipo | **Valor único por tipo**, sem vigência histórica |
| 3 | Colunas de parecer/autorização | **Saem vazias**, com validação de dados (dropdown) já aplicada |
| 4 | Quando a linha aparece | **Só quando houve HE** e o total alcança o **piso de 1 min** — o piso entrou em 09/09/2026 depois de ver dado real; ver §15 |

⚠️ **Risco aceito na decisão 2, registrado uma vez e encerrado.** Sem vigência,
re-gerar a medição de julho depois de um reajuste devolve o preço de hoje, e o
total deixa de bater com o que foi enviado à EDP. O José optou por simplicidade
conhecendo o efeito. **Mitigação obrigatória:** o XLSX gerado carrega, no
rodapé, a data/hora de geração e o valor/hora usado por tipo — a planilha
enviada passa a ser a evidência do preço aplicado, já que o banco não guarda.

---

## 3. Layout da planilha — colunas na ordem exata

Aba principal, espelhando `H.E STC-PLT` (25 colunas, A..Y).

| Col | Cabeçalho | Origem | Temos? |
|---|---|---|---|
| A | EQUIPE | `equipes_oficiais.sigla` | ✅ |
| B | TIPO SERVIÇO | **coluna nova** `equipes_oficiais.servico` (STC/PLT) | ❌ cadastro |
| C | CIDADE | **coluna nova** `equipes_oficiais.cidade` | ❌ cadastro |
| D | ÚLTIMA NOTA | `TIPO - NÚMERO - STATUS` da última nota da sessão | ✅ derivável |
| E | CONCLUSÃO ÚLTIMA NOTA (h) | timestamp da mesma nota | ✅ |
| F | QTD | contagem de notas da sessão | ✅ (ver §6.4) |
| G | VALOR | valor/hora do `tipo_breve` da equipe | ❌ cadastro |
| H | INICIO ESCALA | `escala_dia` × `escalas_catalogo.inicio_escala` | ✅ |
| I | INICIO SESSÃO | `snapshots` → `sessionBegin` (primeira do dia) | ✅ |
| J | ANTECIPAÇÃO | `max(0, H − I)` em horas decimais | ✅ calculado |
| K | FIM DE ESCALA | `escalas_catalogo.fim_escala` (+1 dia se vira-noite) | ✅ |
| L | FIM SESSÃO | `snapshots` → `sessionEnd` (última do dia) | ✅ |
| M | PRORROGAÇÃO | `max(0, L − K)` em horas decimais | ✅ calculado |
| N | TOTAL (DECIMAL) | `round(J + M, 2)` | ✅ |
| O | TOTAL (M) | `round((J + M) × 60)` | ✅ |
| P | DATA | dia da escala | ✅ |
| Q | VALOR TOTAL | `(J + M) × G` — **sem arredondar antes** (ver §4) | ✅ |
| R | PARECER ENGELMIG | — | vazia + dropdown |
| S | JUSTIFICATIVA ENGELMIG | — | vazia (ver §6.5) |
| T | AUTORIZADO POR | — | vazia + dropdown |
| U | PARECER EDP | — | vazia + dropdown |
| V | JUSTIFICATIVA EDP | — | vazia |
| W | OBSERVAÇÕES FINAIS | — | vazia |
| X | ENVIAR COBRANÇA? | — | vazia + dropdown |
| Y | TOTAL FINAL | — | vazia (depende do parecer) |

### Dropdowns (lista `AFIRMATIVAS` da aba DADOS)

A planilha tem **uma** lista para todas as colunas. Proposta de subconjuntos por
coluna, porque a lista inteira num dropdown de parecer oferece nome de pessoa:

- **R, U** (pareceres): `PROCEDENTE`, `IMPROCEDENTE`
- **T** (autorizado por): `BRENDA/DEPT`, `DIEGO`, `LEANDRO CAETANO`,
  `LEONARDO/DEPT`, `MAIKE`, `PAULO CESAR`, `VINICIOS`, `VITOR`,
  `ACORDO 30 MINUTOS`, `EQUIPE PARA COMPENSAÇÃO`, `SEM AUTORIZAÇÃO`,
  `STC ATENDENDO PO`
- **X**: `SIM`, `NÃO`

⬜ **Confirmar com o José.** Se ele preferir a lista única em todas, é um
parâmetro só.

---

## 4. Aritmética — conferida contra os prints

Verificado em 8 linhas de `EPMFL33` e nas primeiras ~57 de `H.E STC-PLT`:

```
antecipacao_h = max(0, inicio_escala − inicio_sessao) / 3600
prorrogacao_h = max(0, fim_sessao   − fim_escala)    / 3600
total_h       = antecipacao_h + prorrogacao_h
TOTAL (DECIMAL) = round(total_h, 2)
TOTAL (M)       = round(total_h × 60)
VALOR TOTAL     = total_h × valor_hora        ← total_h CRU, não o arredondado
```

**Provas:**

| Evidência | Confere |
|---|---|
| 18/07 · fim escala 20:00 · fim sessão 20:43 · 0,719 h · R$ 376,28 → **R$ 270,36** | `270,36 / 376,28 = 0,71850 h` — usa o cru, não `0,72` |
| 01/08 · 22 min · R$ 376,28 → **R$ 137,97** | `22/60 × 376,28 = 137,97` ✓ |
| 06/08 · 2,217 h → **133** min | `2,217 × 60 = 133,0` ✓ |
| 24/07 · fim escala 17:00 · fim sessão **25/07 00:02** · **7,049 h = 423 min** | atravessa a meia-noite ✓ |

⚠️ Usar `TOTAL (DECIMAL)` no lugar de `total_h` no cálculo do dinheiro dá
diferença de centavos por linha e some no total do mês. O arredondamento é
**só de exibição**.

---

## 5. Modelo de dados

### 5.1 Migration — colunas novas em `equipes_oficiais`

```sql
ALTER TABLE public.equipes_oficiais
  ADD COLUMN IF NOT EXISTS cidade     text,
  ADD COLUMN IF NOT EXISTS tipo_breve text,   -- A1 | A2 | A3 | L0M | L1 | L3
  ADD COLUMN IF NOT EXISTS servico    text;   -- STC | PLT
```

Nulas para toda equipe existente; a medição avisa quando falta cadastro em vez
de assumir valor (§6.1). Tabela precisa de `OWNER wpa_app` — ver
`reference-vm-db-shell`.

### 5.2 Valores/hora por tipo breve

Da aba `Valores`:

| tipo_breve | descrição | valor/hora |
|---|---|---|
| A1 | H.E. – HORA EXTRA TURMA LEVE A1 | R$ 356,63 |
| A2 | H.E. – HORA EXTRA TURMA LEVE A2 | R$ 376,28 |
| A3 | H.E. – HORA EXTRA TURMA LEVE A3 | R$ 332,65 |
| L0M | H.E. – HORA EXTRA TURMA LEVE L0M | R$ 122,14 |
| L1 | H.E. – HORA EXTRA TURMA LEVE L1 | R$ 297,54 |
| L3 | H.E. – HORA EXTRA TURMA LEVE L3 | R$ 374,60 |

Guardados em `app_settings` sob a chave `he-valores-hora` (JSON), editável pela
tela do Admin. **Não hardcodar no código-fonte:** preço muda por reajuste e
mudança de preço não pode exigir deploy.

### 5.3 Backfill inicial do cadastro

Script `scripts/migrar-he-cadastro.js`, alimentado pela aba `DADOS` (46 equipes:
sigla, LOCAL, TIPO BREVE, SERVIÇO). **Precisa do arquivo do José** — ler do
print seria transcrever à mão dado que vira dinheiro.

---

## 6. Armadilhas (cada uma já custou incidente neste projeto)

### 6.1 Cadastro faltando não pode virar zero
Equipe sem `tipo_breve` não tem valor/hora. A linha **aparece** com as horas e
`VALOR TOTAL` vazio + aviso na tela ("3 equipes sem cadastro HE"). Preencher com
zero esconderia cobrança; omitir a linha esconderia a hora extra. Regra 7 do
CLAUDE.md.

### 6.2 Vira-noite — comprovado no print, não hipotético
`EBGPR64` em 24/07: fim de escala 17:00, fim de sessão **25/07 00:02**, 423 min.
E o catálogo tem turnos que já começam virando (C17 17:00→02:00, C18 18:00→03:00,
C35 22:35→06:00), então **`fim_escala` também pode ser do dia seguinte**.
Comparar horários sem resolver a data dá prorrogação negativa ou de ~17h. É a
mesma família do P1-14. `db/escalaQueries.js:55` (`turnoCobreAgora`) já resolve
a janela e deve ser reaproveitado, não reescrito.

### 6.3 Relogin no mesmo dia
Equipe que cai e reconecta tem N sessões no dia. Regra: **primeira `sessionBegin`
e última `sessionEnd` do dia** — a equipe esteve em campo do primeiro login ao
último logout. Somar as sessões separadamente cobraria duas antecipações.
`_mergeSessionsBySigla` (`public/index.html:7365`) faz isso no Monitor; a lógica
de HE precisa da mesma regra, no backend.

### 6.4 QTD com 0 e última nota "Interrompida"
Linhas 3 e 4 do print têm **QTD = 0** com 7h de prorrogação e última nota
`DD - ... - Interrompida` / `MD - ... - Interrompido`. Então:
- `QTD` **não** é "notas da sessão" — provavelmente é executadas/concluídas;
- `ÚLTIMA NOTA` inclui nota interrompida, não só executada.

⬜ **Confirmar a definição exata de QTD** antes de implementar. Errar aqui muda
número que a EDP confere.

### 6.5 ANTECIPAÇÃO está zerada em 100% das linhas
Em todas as ~57 linhas visíveis: `INICIO ESCALA = INICIO SESSÃO = 08:00` e
`ANTECIPAÇÃO = 0,000`. Sessão real não começa às 08:00:00 exatas em todos os
dias e todas as equipes — o valor está sendo **copiado da escala**, não medido.

Consequência: o sistema vai medir a antecipação de verdade e ela **pode não ser
zero**. Isso é hora extra que hoje não está sendo cobrada, ou é decisão de
negócio não cobrar.

⬜ **Decisão do José, e é dinheiro:** a antecipação passa a entrar no total, ou
fica como coluna informativa com o total só de prorrogação?

E a coluna `S` (justificativa) do print traz *"Início do deslocamento:
18/07/2026 17:48"* — o sistema **tem** esse dado (aba Deslocamentos). Pode ser
pré-preenchida em vez de vazia. ⬜ Confirmar se ajuda ou atrapalha.

### 6.6 Valor divergente para a mesma equipe
Nas linhas de `ECMRT51` aparecem `R$ 297,54` e `R$ 376,28`. Se a aba `DADOS`
classifica `ECMRT51` como `A22P22D → A2`, o valor correto é 376,28 e algumas
linhas estão com o de L1. **Não afirmo pelo print** — a resolução do OCR não
sustenta. Mas é exatamente a classe de erro que desaparece quando o valor vem do
cadastro em vez de ser digitado, e vale conferir na planilha real.

### 6.7 Aba EQUIPES EXTRAS
Existe, está vazia, e tem layout diferente (sem TIPO SERVIÇO, com OBSERVAÇÃO).
⬜ O que a separa da principal — equipe fora da whitelist? Fora do contrato?
Sem isso, a v1 gera só a aba principal.

---

## 7. Fases

**Fase 1 — cadastro (bloqueante).**
Migration das 3 colunas, `app_settings.he-valores-hora`, edição no Admin,
backfill da aba DADOS. Sem isto, colunas B, C e G saem vazias.

**Fase 2 — cálculo.**
`db/heQueries.js`: junta `escala_dia` × `escalas_catalogo` × sessões de
`snapshots` × notas, resolve vira-noite e relogin, devolve as linhas com HE > 0.
Puras exportadas para teste: resolução da janela, antecipação/prorrogação, total.

**Fase 3 — tela.**
Sub-aba `hist-subtab-he` (o padrão já existe — `switchHistSubtab`,
`public/index.html:5384`), filtros de período/regional/equipe, tabela na ordem
das colunas, e botão "⬇ Baixar XLSX" reusando o SheetJS já vendorizado
(`public/vendor/xlsx.full.min.js`), com validação de dados nas colunas de
parecer e o rodapé de procedência (§2).

**Fase 4 — conferência.**
Gerar a medição de julho/2026 pelo painel e bater linha a linha contra a
planilha que foi enviada à EDP. **Divergência é bug até prova em contrário** —
e é o único critério de aceite que vale.

---

## 8. Critério de aceite

- [ ] Migration aplicada; 46 equipes da aba DADOS com cidade/tipo_breve/servico.
- [ ] Valores editáveis pelo Admin, sem deploy.
- [ ] Vira-noite: `EBGPR64` em 24/07 devolve **423 min**, não negativo nem ~17h.
- [ ] Relogin: equipe com 2 sessões no dia devolve **uma** linha.
- [ ] `VALOR TOTAL` calculado do total cru — a linha de 18/07 devolve
      **R$ 270,36**, não R$ 270,92.
- [ ] Equipe sem cadastro: linha aparece, valor vazio, aviso na tela.
- [ ] Julho/2026 confere linha a linha com a planilha enviada, ou cada
      divergência tem causa escrita.
- [ ] XLSX abre no Excel com as 25 colunas na ordem e os dropdowns ativos.
- [ ] `node --test` sem falha nova.

## 9. Rollback

Fases 2–4 são leitura: `git revert` resolve. A migration da Fase 1 só **adiciona**
colunas nulas — nada existente muda de comportamento, e `DROP COLUMN` reverte se
necessário. `app_settings` é chave nova. **Nenhum dado operacional é reescrito
em nenhuma fase.**

## 10. Pendências — RESPONDIDAS em 09/09/2026

1. ✅ **QTD** = quantidade de notas mesmo. As linhas com `QTD = 0` e 7h de
   prorrogação são exceção real, não erro de leitura: houve prorrogação de 7
   horas sem nota concluída.
2. ✅ **Antecipação ENTRA no total.** `total_h = antecipacao_h + prorrogacao_h`.
   ⚠️ Consequência a acompanhar na Fase 4: hoje a planilha traz antecipação
   0,000 em 100% das linhas, com `INICIO SESSÃO` copiado do `INICIO ESCALA`.
   Medindo de verdade, o total do mês pode subir. **Divergência para MAIS
   contra a planilha enviada é esperada aqui** — é hora extra que não estava
   sendo cobrada, não bug do cálculo.
3. ✅ **Transcrever o cadastro**, deixando editável e revisável. Ver §11.
4. ✅ **Dropdowns:** lista `AFIRMATIVAS` inteira em todas as colunas de parecer.
   Sem subconjunto por coluna — substitui a proposta do §3.
5. ✅ **EQUIPES EXTRAS:** desconsiderar. Uma aba só.

## 11. Fase 1 — ENTREGUE (09/09/2026)

- `db/heCadastroSeed.js` — 45 equipes transcritas da aba DADOS, com
  `tipo_breve` **derivado** da coluna TIPO. Derivar em vez de transcrever a
  coluna TIPO BREVE em separado elimina uma leitura de print: se as duas
  discordassem, a divergência apareceria em vez de eu escolher uma.
- `scripts/migrar-he-cadastro.js` — dry-run por padrão, `--csv` para conferir
  contra a planilha, `--apply` para valer. Transação com rollback.
- Colunas novas em `equipes_oficiais`: `cidade`, `tipo_breve`, `servico`,
  `turno_cadastro`, `he_revisado`.
- Valores/hora em `app_settings.he-valores-hora` — reajuste sem deploy.
- `PUT /api/admin/equipes/:sigla` aceita os 5 campos, com `tipo_breve` fechado
  na lista do contrato. O GET tem fallback para o schema antigo, no molde de
  `services/equipesOficiais.js:219/226` — subir o código antes da migration
  não derruba a tela de Admin, e aqui não há staging pra pegar isso.
- 27 testes.

### A trava da transcrição

Toda linha entra com `he_revisado = false`. A tela da Fase 3 avisa enquanto
houver equipe não revisada no período. E o script **não cria** equipe que não
exista: criar a partir de transcrição de print a colocaria na whitelist e ela
passaria a contar em **todas** as métricas do painel, muito além da medição.

### Conferência cruzada que a transcrição passou

O `tipo_breve` lido na aba DADOS foi cruzado com a coluna VALOR da aba de
medição — leitura independente do mesmo print. **22 das 45 conferem**; as 23
sem cruzamento são as que precisam de olho humano, e estão marcadas
(`conferido: false`).

Duas divergências anotadas, não escondidas:

- **ECMRT51** — DADOS diz `A2 2P 22D` (R$ 376,28), mas a medição tem linhas a
  R$ 297,54, que é L1. Se confirmado, são linhas **cobradas a menos**.
- **EPGPR32** — a coluna TIPO BREVE ficou ambígua no print; `A3` foi derivado
  da coluna TIPO.

### Achado que corrobora o P2-47

A aba DADOS tem 45 equipes e **não** inclui `ETGPR18`, `ETGPR19`, `ETMRT15`
nem `ETPKE15` — que estão ativas em `equipes_oficiais`. São **4 das 10** que o
P2-47 achou sem nenhuma linha de escala no mês inteiro. Duas fontes
independentes apontando as mesmas equipes é indício forte de que não operam
mais. Ver P2-47 antes de cadastrá-las.

## 12. Fase 2 — ENTREGUE (09/09/2026)

`db/heQueries.js`. Puras exportadas e testadas: `msParede`, `janelaDaEscala`,
`janelaMaisAmpla`, `sessaoDoDia`, `calcularHe`, `valorTotalHe`, `temHe`,
`ultimaNotaDaSessao`. 40 testes.

**Hora de parede, sem conversão.** Os dois lados da subtração são lidos do
mesmo jeito. Se algum dia o `session_begin` vier com `Z`, a função converte em
vez de errar 3h em silêncio.

**Vira-noite nas duas pontas** — a sessão que fecha 00:02 e o turno de escala
que já começa virando. A query usa lookahead de +1 dia (o logoff fica no
snapshot do dia seguinte, `db/queries.js:341`) e agrupa a sessão pelo dia do
`session_begin`, não do snapshot.

**Escolhas conservadoras**, cada uma no lado que não infla a fatura: dois
códigos no dia → janela mais ampla; sessão aberta → fim null e linha
incompleta; sem cadastro → valor null; janela ambígua → null.

**QTD = `concluidas`**, não `executadas`: no histórico `notasExecutadas` vem
vazio de propósito (`wpaService.js:1678`). `_qtd_executadas` segue no objeto
pra Fase 4 testar a outra contagem sem refazer nada.

## 13. Fase 3 — ENTREGUE (09/09/2026)

- `GET /api/he/medicao?de=&ate=&regionals=&team=` — regional do `req.scope`,
  teto de 93 dias (a medição varre snapshots do intervalo; range aberto derruba
  a VM de 3,8GB).
- Sub-aba `⏱ Medição HE` no Histórico, lazy (`_heCache`). Usa o período e a
  regional do filtro que já existe na aba.
- Tabela com 17 colunas na tela; **as 25 na ordem exata** no XLSX.
- Botão `⬇ Baixar XLSX` → `medicao-he-<de>-a-<ate>.xlsx`, com três abas:
  `H.E STC-PLT` (dados), `AFIRMATIVAS` (a lista inteira) e `PROCEDÊNCIA`.
- 15 testes, com destaque pro que fixa a **ordem** das colunas: coluna fora de
  lugar quebra o encaixe no template em silêncio e nenhum teste de cálculo pega.

### ⚠️ Duas limitações, ditas de frente

**1. O XLSX não tem dropdown.** O SheetJS community 0.20.3 vendorizado **não
escreve validação de dados** — conferido, zero ocorrência de `dataValidation`
no bundle. A spec §3 prometeu "dropdown pronto"; não dá com esta biblioteca.
O que foi entregue: a lista `AFIRMATIVAS` completa numa aba própria, e as
colunas de parecer vazias na ordem certa. A validação continua no seu template
— ou cole os dados nele, que era o fluxo de sempre.

**2. Datas saem como TEXTO** em `DD/MM/YYYY HH:MM:SS`, não como data do Excel.
Como objeto `Date`, SheetJS e Excel reinterpretam fuso, e 3h aqui mudam
dinheiro sem avisar. O custo é que não dá pra ordenar como data na planilha.

### Procedência em aba separada, não em rodapé

A spec §2 pedia rodapé na aba de dados. Ficou em aba própria (`PROCEDÊNCIA`):
rodapé atrapalharia colar os dados no template. A função evidenciária é a
mesma — sem vigência histórica no banco, esta planilha é a prova do preço
aplicado. Ela traz data de geração, período, totais, valor/hora por tipo e as
listas de equipe sem cadastro / não revisada.

## 14. Próximo passo — Fase 4 (a única que vale como aceite)

Gerar julho/2026 pelo painel e bater **linha a linha** contra a planilha
enviada à EDP. Divergência é bug até prova em contrário, com **duas exceções
previstas**:

1. **Antecipação** — a planilha atual traz 0,000 em 100% das linhas, com
   `INICIO SESSÃO` copiado do `INICIO ESCALA`. Medindo de verdade, o total
   sobe. Divergência para MAIS é esperada aqui.
2. **QTD** — se divergir, testar `_qtd_executadas` antes de mexer no cálculo.

## 15. Piso de 1 minuto — decidido em 09/09/2026, com dado real

Na 1ª rodada em produção o critério era "qualquer ponta > 0" (decisão 4, §10) e
apareceu a `ECGPR51`: prorrogação de **0,003 h — onze segundos** — com
`TOTAL (M) = 0` e **R$ 0,86** cobrados. Não é hora extra, é jitter de
sincronização do app. E uma linha de 11 segundos numa planilha de cobrança é o
que um auditor usa para questionar as outras 405.

O José definiu **piso de 1 minuto no TOTAL** (antecipação + prorrogação).

### Três decisões dentro do piso

**1. A comparação é em milissegundos.** `total_h * 3600` de uma diferença de
60.000 ms dá `59,99999999999999` — erro de float que descartaria uma linha
legítima de exatamente 1 minuto. `calcularHe` passou a devolver `total_ms`
inteiro, e é contra ele que o piso compara. Testado nas duas bordas: 59s fora,
60s exatos dentro.

**2. Sessão ABERTA passa SEM o piso.** Com a sessão em aberto a prorrogação é
DESCONHECIDA — pode ser de horas. Não se pode afirmar que o total está abaixo
de 1 minuto. A linha fica, marcada `incompleta`, e a tela avisa. Aplicar o piso
ali esconderia justamente o caso que precisa de conferência.

**3. O descarte NUNCA é silencioso.** O resumo devolve `descartadas_piso`,
`descartadas_min` e `descartadas_valor`; a tela mostra num aviso e o XLSX
registra na aba `PROCEDÊNCIA`, junto com o piso aplicado. Sem isso, "faltam
linhas" na conferência da Fase 4 não teria explicação — e uma reconferência
futura com outro piso não fecharia sem ninguém saber por quê.

### Primeira medição completa (16/08 a 31/08/2026, antes do piso)

- 406 linhas · 39 equipes · **400,29 h** (55,55 antecipação + 344,73 prorrogação)
- **R$ 133.738,13** antes do parecer
- 131 linhas com relogin · 26 com sessão aberta · 1 dia sem escala

Os 55,55 h de antecipação são o número que a planilha manual zera. É a
divergência prevista da Fase 4 (§14), e agora tem tamanho.

## 16. Aberto para a Fase 4

⬜ **A última nota está vindo 100% `PO`.** Nas linhas conferidas em produção,
todas. Na planilha manual os tipos variam (`DD`, `MD`, `LE`, `LN`, `SM`, `RL`,
`UG`, `DL`). Hipótese: `ultimaNotaDaSessao` escolhe pelo `conclusionDate` mais
recente, e talvez só parte dos tipos carregue esse campo nos snapshots — aí
sempre vence quem tem. **É o 1º item a conferir**, porque a coluna D divergiria
sistematicamente.

⬜ **26 sessões abertas num período fechado** (16–31/08, já passado). São
equipes que não deslogaram. Prorrogação não medida, então essas linhas cobram
MENOS que o devido. Decidir se entram na fatura assim, ficam de fora, ou viram
pendência operacional.

⬜ **Cachoeiro e São José têm medição HE própria?** As 26 equipes de CAC
mantiveram tipo operacional (`PLANTÃO`/`COMERCIAL`/`USO MUTUO`) e aparecem como
"sem cadastro HE". Se não houver medição pra elas, esse aviso é ruído
permanente e vale separar "sem tipo cadastrado" de "regional sem medição HE" —
aviso que sempre aparece é aviso que se aprende a ignorar.

## 17. Sessões abertas — analisado em 09/09/2026

Pedido: *"2: VAMOS ANALISAR"*. Ferramenta:
`scripts/diag-he-sessoes-abertas.js` (read-only).

### Achado 1 — BUG MEU: o logoff estava no jsonb

`dataWriter.saveSnapshot` (`dataWriter.js:48`) grava a coluna `session_end` no
momento do snapshot. Mas `runSyncLogoffs`, das 03:00
(`cronService.js:1619`) — o job que existe justamente pra pegar o logoff de
quem saiu DEPOIS do último snapshot do dia — faz `update({ data: newData })`
e **não toca na coluna**.

Eu escolhi ler a coluna por ser indexada, e ela é exatamente a que o back-fill
não mantém. O código antigo do painel (`queries.js:402`) sempre leu do payload.

**Medido:** 277 de 2.137 sessões (13,0%) apareciam abertas. Com
`COALESCE(session_end, data->>'sessionEnd', data->>'session_end')`, caíram pra
**113 (5,3%)** — **164 sessões recuperadas**, e a aritmética fecha
(277 − 164 = 113).

**Efeito no dinheiro:** a prorrogação de todo turno que atravessa a meia-noite
estava subnotificada. São os `EP*` de plantão, o turno em que hora extra mais
acontece. Os R$ 133.738,13 da 1ª medição estavam ABAIXO do devido.

⬜ **Backlog:** `runSyncLogoffs` deveria manter coluna e jsonb em sincronia.
Qualquer código futuro que leia a coluna cai na mesma armadilha — eu caí. É
conserto em caminho de ESCRITA de produção, então não foi feito junto.

### Achado 2 — as 113 restantes são, na maioria, o incidente do P1-39

Distribuição: **SJC 74**, GUA 20, CAC 19. E no detalhe aparecem 11 equipes de
SJC congeladas no MESMO instante — `2026-08-24 10:15:05`, com login entre 06:43
e 07:57.

Isso é a parada de coleta de **24-25/08/2026 (credencial SJC inválida)**, que
originou o próprio P1-39. As sessões estavam abertas quando a coleta morreu e
nunca receberam logoff, porque não havia coleta.

Não é bug da medição: é lacuna de dado conhecida e datada. Para 24-25/08 a
prorrogação de SJC é genuinamente imensurável.

### Achado 3 — resíduo real de turno noturno

Fora do incidente, sobra um punhado recorrente: `EPGPR30` (14), `EPPTE04` (12),
`EPAVP38` (8), `EPCIT33` (7), `EPCIT32` (7). Login entre 17:00 e 22:54, último
snapshot 23:45, relogin no dia seguinte. Nestas, nem o job das 03:00 capturou o
logoff. `EPPTE04` chama atenção por relogar de madrugada (03:11, 04:51, 05:34),
o que sugere sessão perdida e reautenticação, não turno.

### Correções de método no próprio script

1. **Não conclua "abandono" por relogin.** A 1ª versão rotulou 259 turnos
   noturnos legítimos como lixo porque a equipe logou de novo depois — turno
   diário relogá todo dia no mesmo horário. Se a recomendação tivesse sido
   seguida, 259 linhas boas sairiam da fatura.
2. **Concentração por DIA, não só por equipe.** A lente por equipe diz
   "espalhado" quando a causa é uma parada de coleta, porque o incidente atinge
   todas as equipes da regional ao mesmo tempo. O script passou a marcar dia
   com mais de 2,5× a média e a mostrar o horário do último snapshot — é o que
   faz 24/08 saltar aos olhos.

## 18. Recuperação dos logoffs — 113 de 113 (09/09/2026)

`scripts/recuperar-logoffs.js --apply`, período 16–31/08:

```
✔ 113 sessão(ões) com o fim recuperado da EDP.
  0 sem par na EDP.
```

**Recuperação total.** Toda "sessão aberta" tinha o logoff na API da EDP —
incluindo as **49 de DSSJ em 24/08**, porque o P1-39 foi credencial NOSSA
inválida, não perda de dado deles.

### O que isso corrige no raciocínio

O José disse: *"não faz sentido termos sessão em aberto de um dia fechado"*.
Estava certo, e o dado confirmou 113 vezes. Antes dessa observação a análise
estava indo pro lugar errado: eu apresentei as 113 como **decisão de negócio**
("cobrar só a antecipação ou deixar fora?"), quando eram **falha de captura**.
Não havia nada imensurável — havia dado que não foi buscado.

⚠️ **Lição pro próximo diagnóstico:** "estado impossível na operação" é sinal de
bug de captura, não de estado a modelar. Equipe vai pra casa; sessão de dia
fechado tem fim. Sempre.

### Consequência pro `runSyncLogoffs` (P1-47)

Se a EDP tinha 100% dos fins, o job das 03:00 está deixando passar tudo o que
não fecha antes dele. E vale suspeitar de mais: ele casa por **string exata**
(`sb1 === beginTime`), enquanto a recuperação casou 113/113 com o instante
**normalizado**. Formato com milissegundo ou offset diferente não casa por
string.

⬜ Depois de consertar o horário (reprocessar D-2), **medir quantos logoffs o
job efetivamente grava por noite**. A suspeita é que a contribuição dele seja
próxima de zero e que os 2.024 fins que já existiam venham todos do snapshot
normal (05:00–23:45), não dele.

### Os três consertos do dia, na ordem

A primeira medição de 16–31/08 mostrou **R$ 133.738,13**. Estava abaixo do
devido por três defeitos meus, todos encontrados por observação do José ou pelo
dado:

1. `R$ 0,00` no cartão de valor quando nenhuma linha tinha cadastro — número
   falso se passando por fato.
2. Logoff lido da coluna `session_end` quando o back-fill grava no jsonb —
   164 sessões tratadas como abertas.
3. 113 logoffs nunca buscados na EDP — prorrogação de turno noturno perdida.

Nenhum deles apareceria numa conferência que só olhasse o total.

## 19. Regra do "Acordo 30 min" (09/09/2026)

Pedido: *"quando uma equipe aponta o deslocamento para a última nota do dia
pelo menos 30 minutos antes do fim da escala… uma coluna com o horário indicado
do apontamento de deslocamento para a nota e uma coluna com a condição
respondida"*.

**A lógica de negócio:** se a equipe já estava a caminho da última nota bem
antes do turno fechar, a hora extra é legítima — foi despachada em tempo e o
serviço passou do horário. É a justificativa que hoje é digitada à mão na
coluna `AUTORIZADO POR`, onde `ACORDO 30 MINUTOS` é um dos valores da lista
`AFIRMATIVAS`.

### Duas colunas novas, NO FIM

`INÍCIO DESLOC. ÚLTIMA NOTA` (Z) e `ACORDO 30 MIN` (AA), **depois** de
`TOTAL FINAL`. As 25 primeiras seguem espelhando a planilha, na ordem dela —
inserir no meio deslocaria todas as seguintes e quebraria o encaixe no template
em silêncio. Um teste fixa essa invariante.

⚠️ **Não preenche a coluna `AUTORIZADO POR` automaticamente.** Coerente com a
decisão 3 (§10): o sistema não emite parecer nem autorização. Ele responde a
condição factual e o humano decide se leva pro campo de autorização.

### De onde sai

Checkpoint **`event = 0` (Início do Deslocamento)** da última nota do dia,
lendo `registradoEm` — que vem de `RegisteredAt2`.

⚠️ **Nunca `TimeStamp`.** Nos eventos 0 e 1 o `TimeStamp` é o relógio do
aparelho no momento da SINCRONIZAÇÃO: medido na nota 104875481, deu **55 min**
de erro no evento 0. Tabela em `docs/handoff/API-WPA-EDP.md`.

**Vale o PRIMEIRO `event = 0`**, não o último. "Cada novo event=0 começa uma
tentativa" — e a pergunta é "foi despachada em tempo?", que fala do primeiro
despacho. Usar o último premiaria quem tentou de novo tarde.

### Três estados, e a diferença entre dois deles é o ponto

| Estado | Tela | XLSX |
|---|---|---|
| Cumpriu | `Acordo 30 min` (verde) | `Acordo 30 min` |
| Não cumpriu | `não` | *(vazio)* |
| **Sem checkpoint** | `sem dado` (âmbar) | *(vazio)* |

⚠️ `acordo30` devolve **null**, nunca `false`, quando falta o checkpoint.
`false` diria "conferimos e a equipe não cumpriu" — afirmação sobre a equipe,
numa coluna que vira justificativa de cobrança. O resumo separa
`acordo_sim` / `acordo_nao` / `acordo_sem_dado`, e a tela avisa quantas ficaram
sem avaliação.

A fronteira é **inclusiva**: exatamente 30 min antes cumpre ("pelo menos 30").

Turno vira-noite usa o fim REAL da escala — pra um C17 (17:00→02:00) a
comparação é contra 02:00 do dia SEGUINTE.

### Custo

Os checkpoints das últimas notas são lidos em **uma consulta em lote** depois
do laço. Uma por linha seriam ~400 consultas e custaria mais que a medição
inteira. Cobertura depende de `note_details`, populada por cron — nota antiga
pode não estar lá, e aí a linha cai em "sem dado".

## 20. Segunda regra pedida — BLOQUEADA, falta definição

Pedido: *"adicionar uma coluna com o horário e o tempo do último deslocamento
para a base"*.

**Não há dado de "base" no sistema.** Verificado em 09/09/2026:

- os checkpoints documentados são `0..4` e **todos pertencem a uma NOTA**
  (`docs/handoff/API-WPA-EDP.md`); não existe evento de retorno;
- `db/deslocamentosQueries.js` só pareia `0→1` dentro de notas — não modela
  base;
- não há localização de base em `equipes_oficiais` nem em lugar nenhum.

⬜ **Precisa da definição do José.** Candidatas, e cada uma dá número diferente:

1. **Do fim do trabalho da última nota até o logoff** — `event 3` da última
   nota → `sessionEnd`. Usa só dado que já temos. É a interpretação mais
   provável: a equipe fecha a última nota, dirige de volta e desloga na base.
2. **Do último `event 1` (Fim do Deslocamento) até o logoff** — variante que
   ancora no fim do último deslocamento registrado.
3. **Um apontamento próprio no app**, que existiria em outro endpoint ainda
   não mapeado. Se for este, precisa de investigação na API antes de qualquer
   código.

Enquanto não houver definição, a coluna não foi criada — inventar a régua aqui
poria um número fabricado numa planilha de cobrança.
