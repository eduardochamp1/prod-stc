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
| 4 | Quando a linha aparece | **Só quando houve HE** (antecipação > 0 **ou** prorrogação > 0) |

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

## 12. Próximo passo — Fase 2

`db/heQueries.js`: escala × sessão × notas, resolvendo vira-noite (§6.2) e
relogin (§6.3). Nada bloqueia.
