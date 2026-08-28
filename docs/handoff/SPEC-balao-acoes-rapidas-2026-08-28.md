# SPEC — Balão lateral de ações rápidas (Acordar WPA + Atualizar)

> Data: 2026-08-28 · Pedido do José (com print de referência). Status:
> **desenhado, não implementado**. O CSS já existe no working tree
> (`public/css/app.css`, bloco "AÇÕES RÁPIDAS — balão lateral", 28/08/2026,
> ainda uncommitted); falta HTML + JS.
>
> Mudança **puramente de frontend**. Não toca backend, agregação, cron nem
> nenhum número reportado à EDP.

## 1. Objetivo

Tirar `⚡ Acordar WPA` e `↻ Atualizar` das barras de filtro e concentrá-los num
balão fixo colado na borda direita — colapsado é só um círculo; ao clicar,
expande pra esquerda com os dois botões. Disponível nas **9 abas**.

Hoje o `↻ Atualizar` é **8 botões distintos**, um por aba, cada um chamando seu
próprio loader — e a aba **Notas não tem nenhum**. O `⚡ Acordar WPA` só existe
no header do Monitor, apesar de ser uma ação global (acorda o App Service da
EDP, que serve todas as abas).

## 2. Decisões (fechadas no brainstorm de 28/08/2026)

| # | Decisão | Escolha |
|---|---|---|
| D1 | Os botões atuais saem ou o balão é acréscimo? | **Saem de vez.** O balão é o único caminho. |
| D2 | Símbolo do círculo | **`⚡` sobre amarelo `--amarelo`**, raio preto. |
| D3 | Clicar num botão fecha o balão? | **Não.** Fecha só por `⚡`, ESC ou clique fora. |
| D4 | Onde mora o dispatch do Atualizar | **Registro explícito** `FAB_RECARREGAR`. |
| D5 | Loader da aba Notas | `loadNotasAll()`, não `initNotas()`. |

**Por que D3:** `acordarWpa()` escreve o resultado dentro do próprio `#btn-warm`
(`✓ WPA pronto (2.3s)` / `⚠️ Falhou`) e só restaura depois de **5s**. Não existe
toast no app. Se o balão fechasse no clique, esse feedback sumiria. Consequência
de projeto: **`acordarWpa()` não é modificada** — o `id="btn-warm"` viaja junto
pro balão e a função continua idêntica.

**Por que D2 e não a seta `‹`:** o CSS entregue gira o toggle 180° quando aberto.
Isso só significa algo em símbolo direcional. Com `⚡` a rotação vira giro
decorativo (e raio de cabeça pra baixo não comunica nada) → a regra
`rotate(180deg)` **sai**, e o estado passa a ser sinalizado trocando o glifo
`⚡` ⇄ `✕`.

## 3. O que sai (inventário verificado em 28/08/2026)

Nove botões, todos em `public/index.html`:

| Aba | Linha (hoje) | Botão | Loader |
|---|---|---|---|
| Monitor | 144-146 | `⚡ Acordar WPA` | `acordarWpa()` |
| Monitor | 147 | `↻ Atualizar` | `loadData()` |
| Rejeições | 329 | `↻ Atualizar` | `loadRejeicoes()` |
| Metas | 348 | `↻ Atualizar` | `loadMetasCalculadas()` |
| Ranking | 382 | `↻ Atualizar` | `loadRanking()` |
| Mapa | 470 | `↻ Atualizar` | `loadMapa()` |
| Deslocamentos | 519 | `↻ Atualizar` | `loadDeslocamentos()` |
| Histórico | 632 | `↻ Atualizar` | `loadHistorico()` |
| Gráficos | 728 | `↻ Atualizar` | `loadGraficos()` |

**NÃO mexer** (parecem alvo, não são):

- `↩ Hoje` (linha 143) — é navegação de data, não recarga.
- `⬇ Baixar XLSX` (linha 633) — vizinho do Atualizar do Histórico, fica.
- `↻ Listar` (linha 797) — está dentro do **modal Admin**, não é aba.

## 4. Frontend — markup

Um único bloco, **irmão dos `.tab-panel`, fora de todos eles**. Como é
`position: fixed`, aparece nas 9 abas sem repetição de markup — é isso que
resolve "em todas as páginas".

```html
<div class="fab-acoes" id="fab-acoes">
  <div class="fab-acoes-painel" id="fab-acoes-painel" role="group"
       aria-label="Ações rápidas" hidden>
    <span class="fab-acoes-titulo">Ações rápidas</span>
    <span class="fab-acoes-alvo" id="fab-acoes-alvo"></span>
    <button class="btn-refresh" id="btn-warm" onclick="acordarWpa()"
      title="Força um login no WPA — útil quando o Azure App Service hiberna e clicar em OS retorna 502">⚡ Acordar WPA</button>
    <button class="btn-refresh" onclick="fabRecarregar()">↻ Atualizar</button>
  </div>
  <button class="fab-acoes-toggle" id="fab-acoes-toggle"
          aria-expanded="false" aria-controls="fab-acoes-painel"
          aria-label="Abrir ações rápidas" onclick="fabToggle()">⚡</button>
</div>
```

O `id="btn-warm"` e o `title` **migram literalmente** — `acordarWpa()` depende
dos dois.

## 5. Frontend — dispatch do Atualizar

`let currentTab` (linha 1834) já é a fonte de verdade da aba ativa.

```js
// Um botão só recarrega 9 abas. O alvo é a aba ativa (currentTab).
// Arrow-wrapped de propósito: metade destes loaders é declarada milhares de
// linhas ABAIXO deste ponto — referência direta quebraria por hoisting.
const FAB_RECARREGAR = {
  monitor:   { fn: () => loadData(),            rotulo: 'Monitor' },
  rejeicoes: { fn: () => loadRejeicoes(),       rotulo: 'Rejeições' },
  desloc:    { fn: () => loadDeslocamentos(),   rotulo: 'Deslocamentos' },
  notas:     { fn: () => loadNotasAll(),        rotulo: 'Notas' },
  graficos:  { fn: () => loadGraficos(),        rotulo: 'Gráficos' },
  ranking:   { fn: () => loadRanking(),         rotulo: 'Ranking' },
  mapa:      { fn: () => loadMapa(),            rotulo: 'Mapa' },
  historico: { fn: () => loadHistorico(),       rotulo: 'Histórico' },
  metas:     { fn: () => loadMetasCalculadas(), rotulo: 'Metas' },
};
```

**Rejeitado — reusar `switchTab(currentTab)`:** `switchTab` (1859-1899) **não tem
ramo pro `monitor`** (o Monitor carrega no boot). Reusar deixaria o Atualizar da
aba principal sem fazer nada, em silêncio. Além disso `switchTab` re-sincroniza
dropdowns num `setTimeout` — efeito colateral indesejado num "recarregar".

**Rejeitado — cada aba se registrar no seu `init`:** espalharia a informação por
8,6k linhas de monólito. Piora o risco H11 do backlog.

**Por que `loadNotasAll()` e não `initNotas()` (D5):** `initNotas()` (1903)
monta o MultiSelect na primeira vez e *depois* chama `loadNotasAll()` (1916).
Para "recarregar", a metade certa é `loadNotasAll()`.

`fabRecarregar()` lê `FAB_RECARREGAR[currentTab]`; se a chave não existir, faz
`console.warn` e não quebra.

`#fab-acoes-alvo` exibe `Recarrega: <rotulo>`, atualizado no fim de `switchTab`.
Sem isso o botão único fica ambíguo, já que ele não vive mais dentro da aba.

## 6. Frontend — abrir/fechar

Classe `.aberto` no `#fab-acoes`. Fecha por:

- clique no `⚡` (toggle);
- **ESC** — pendurar no handler global que já existe (linha 7678, junto de
  `closeModalDirect()` / `closeNotaDirect()` / `closeLightbox()`);
- **clique fora** — padrão já usado nos painéis de Tipos/Subcategorias
  (linhas 3623 e 5884).

Clique nos dois botões **não** fecha (D3).

## 7. Acessibilidade

- `hidden` no painel enquanto fechado, pra o Tab não parar em botão invisível
  (o comentário do CSS entregue já pedia isso).
- `aria-expanded` no toggle acompanha o estado; `aria-controls` aponta o painel.
- Ao abrir, foco vai pro primeiro botão; no ESC, volta pro toggle.
- `:focus-visible` com contorno verde já está no CSS.

## 8. CSS — o que já existe e o que ajustar

Bloco "AÇÕES RÁPIDAS — balão lateral" em `public/css/app.css` (uncommitted,
~109 linhas). Já cobre: posicionamento fixo, `z-index: 900` (abaixo dos modais
em 1000/9999, acima do conteúdo), transição de `max-width`, breakpoint
≤640px (`bottom: 84px`) e `prefers-reduced-motion`.

Dois ajustes:

1. **Remover** `.fab-acoes.aberto .fab-acoes-toggle { transform: rotate(180deg) }`
   — ver D2.
2. **Consolidar** a declaração duplicada de `.fab-acoes-toggle` (a 2ª, logo
   abaixo da regra de rotação, sobrescreve a `transition` da 1ª).

## 9. Texto colateral

Quatro empty-states mandam clicar num botão que deixa de existir na barra:
linhas **387**, **649**, **653** e **2519** ("Selecione um mês e clique em
Atualizar." / "clique em Atualizar."). Como todos os loaders já rodam sozinhos
no `switchTab` e no `onchange` dos filtros, esses textos já estavam
desatualizados — hoje piscam por um instante antes de serem substituídos.

Viram `Carregando…`.

## 10. Casos de borda

- **Aba nova sem registro** → `fabRecarregar()` não quebra (`console.warn`), e o
  teste de invariante (§11) pega antes disso chegar em produção.
- **Modal aberto** → o balão fica atrás (z-index 900 < 1000). Correto.
- **Clique em Atualizar durante o ciclo de 5s do Acordar WPA** → independentes,
  sem conflito: um escreve em `#sync-label`, o outro em `#btn-warm`.
- **Perfil regional** → nenhuma mudança. Os loaders já aplicam escopo.

## 11. Testes (`node --test`)

O repo **não tem harness de frontend** — a suíte inteira é backend, sem jsdom
(baseline medida em 28/08/2026: **630 testes / 45 suites / 0 falhas**, ~10,5s).
Não dá pra testar clique. Dá pra testar invariante lendo `public/index.html`
como texto, no estilo do repo (assert puro, sem framework):

1. todo `id="tab-X"` do HTML tem chave correspondente em `FAB_RECARREGAR`
   — **este é o teste que importa**: pega o modo de falha real, que é adicionar
   aba nova e esquecer de registrar;
2. `id="btn-warm"` aparece exatamente **uma** vez;
3. nenhum `↻ Atualizar` sobrou dentro de um `.tab-panel`;
4. toda `fn` do registro referencia função que existe no arquivo.

**Limite explícito:** isso é verificação estática. **Não prova que o balão abre.**
A conferência de clique nas 9 abas é manual, no navegador.

## 12. Não-objetivos (YAGNI)

- Não adicionar outras ações ao balão (exportar, imprimir, etc).
- Não lembrar aberto/fechado entre sessões (`localStorage`).
- Não mudar o que cada loader faz.
- Não mexer no `↻ Listar` do modal Admin.
- Não resolver o Histórico chamar `loadHistorico()` sem olhar a sub-aba ativa
  (`sessoes` × `subcats`) — comportamento **idêntico ao de hoje**, mantido de
  propósito. Se for problema, vira item de backlog separado.

## 13. Rollback

`git revert` de um commit. Sem migração, sem estado, sem backend. Reverter
devolve os nove botões às barras de filtro.

## 14. Riscos

- **Mudança de hábito.** Quem usa o painel há meses tem memória muscular do
  botão na barra de filtros. Mitigação: círculo sempre visível +
  `#fab-acoes-alvo` dizendo qual aba será recarregada. Vale avisar a equipe.
- **Telas ≤640px.** O CSS joga o balão pra `bottom: 84px`. Não verificável sem
  dispositivo real — conferir na entrega.
