# SPEC — Retenção ilimitada de `note_details` (fim do TTL de 90 dias)

> Data: 2026-08-28 · Decidido com o José no levantamento das sub-abas da aba
> Deslocamento. Status: **desenhado e aprovado, não implementado**.
>
> Resolve o item **P2-18** do backlog.
>
> Mudança de **retenção**, não de cálculo. Não altera nenhum número exibido hoje,
> não toca agregação, não toca o que é reportado à EDP. O efeito é só um: parar
> de apagar.

## 1. Objetivo

`cleanOldNoteDetails` apaga toda linha de `note_details` com `fetched_at` mais
velho que 90 dias. Essa tabela é a **única fonte** de duas coisas que não existem
em nenhum outro lugar:

- os **checkpoints** (`payload.checkpoints[]`), matéria-prima da aba Deslocamento;
- as **datas da nota** (`payload.datas.emissao` / `.conclusao`), matéria-prima do
  TMA regulatório.

Nada disso é reconstruível depois: exigiria 1 request por nota em meses passados,
na conta da EDP que **bloqueia após 5 falhas de login**.

Objetivo: tornar a retenção configurável e **ilimitada por padrão**, exatamente
como já é a de `snapshots`.

## 2. Por que agora (a decisão tem prazo)

Medido na VM em 28/08/2026:

| | |
|---|---|
| Linhas hoje | 78.367 |
| Tamanho | 268 MB (**3,58 KB/nota**) |
| Ritmo (média de 7 dias) | **877 notas/dia** → 3,1 MB/dia |
| Crescimento anual | **~1,15 GB/ano** |
| Contrato inteiro (60 meses) | **~5,7 GB** |
| Disco livre na VM | **57 GB** de 96 GB (42% em uso) |
| Banco hoje | 3.738 MB |

**O argumento que fecha:** `snapshots` já cresce **16 MB/dia** (~5,8 GB/ano), e
isso foi aprovado deliberadamente em 07/07/2026. Reter `note_details` para sempre
custa **3,1 MB/dia — 20% de um custo que já é aceito**. Somando os dois, ~7 GB/ano
contra 57 GB livres: **~8 anos de folga** num contrato de 5.

**E já está custando.** O registro mais antigo é de **28/05/2026**, enquanto o
histórico de `snapshots` começa em 09/05/2026. Uns **19 dias de detalhes já foram
apagados e não voltam**. O cron apaga mais um dia a cada madrugada.

Isso inverte o perfil de risco habitual: aqui o risco é **não fazer**.

## 3. Decisão

Espelhar o padrão que já existe para snapshots — mesma semântica, mesmo formato
de nome, mesmo aviso. Sem inventar mecanismo novo.

| # | Decisão | Escolha |
|---|---|---|
| D1 | Apagar de vez a função de limpeza? | **Não.** Vira configurável, como a de snapshots. |
| D2 | Default | **Ilimitado** (`0`/ausente = nunca apaga). |
| D3 | Nome da variável | `NOTE_DETAILS_RETENTION_DAYS`, paralelo a `SNAPSHOT_RETENTION_DAYS`. |
| D4 | Extrair tabelas estreitas (`note_fatos`, `note_checkpoints`)? | **Não.** Ver §7. |
| D5 | Normalizar o fuso dos payloads antigos agora? | **Não.** Ver §8. |

**Por que D1 e não deletar a função:** manter o botão permite reativar a limpeza
sem deploy se o disco apertar um dia. Deletar a função tornaria isso um patch de
emergência sob pressão.

**Por que D4:** o desenho inicial previa duas tabelas estreitas com campos
escolhidos a dedo. Reter o bruto é mais barato de construir *e* estrategicamente
melhor: qualquer indicador futuro (TMA, ICC, TMP, o que vier) nasce
backfillável, sem precisar adivinhar hoje quais campos alguém vai querer amanhã.
É literalmente a promessa da decisão de 07/07/2026, que o TTL de 90 dias
contradizia.

## 4. Implementação

Um arquivo de código, um de documentação, um de teste.

### 4.1 `services/dataWriter.js` — `cleanOldNoteDetails`

Guarda no topo da função, no molde de [`cleanOldSnapshots`](../../services/dataWriter.js):

```js
// Retenção configurável via NOTE_DETAILS_RETENTION_DAYS no .env.
// 0 ou ausente = NUNCA apaga. Mesma decisão de negócio que vale pra snapshots
// (07/07/2026): manter o bruto pra reprocessar métricas futuras.
// note_details é a ÚNICA fonte de checkpoints (aba Deslocamento) e das datas de
// emissão/conclusão (TMA) — e NÃO é backfillável: exigiria 1 request por nota em
// meses passados, na conta que bloqueia após 5 falhas. Custo medido em
// 28/08/2026: 3,1 MB/dia ≈ 1,15 GB/ano, contra os 16 MB/dia que snapshots já
// gasta. Ver docs/handoff/SPEC-retencao-note-details-2026-08-28.md.
const retentionDays = parseInt(process.env.NOTE_DETAILS_RETENTION_DAYS || '0', 10);
if (!retentionDays || retentionDays <= 0) {
  log.info('clean_note_details_skipped', { reason: 'retencao ilimitada (NOTE_DETAILS_RETENTION_DAYS nao setado)' });
  return;
}
```

O corpo atual segue inalterado abaixo da guarda, trocando o cutoff fixo de 90
dias por `dateBRTMinusDays(retentionDays)`.

**Nota de comportamento preservada:** a limpeza filtra por `fetched_at`, não pela
data da nota. Nota buscada hoje sobrevive 90 dias a partir da **busca**, não da
conclusão. Isso não muda nesta spec — só fica registrado, porque enganou na
leitura inicial.

### 4.2 `.env.example`

Entrada nova junto de `SNAPSHOT_RETENTION_DAYS`, com o mesmo cabeçalho de perigo.
O teste [`envExample.test.js`](../../test/envExample.test.js) exige `DESTRUTIVO` e
`ILIMITADA` no bloco de comentário acima da chave, e a varredura de
`process.env.NOME` **falha a suíte** se a chave não for documentada — a cerca já
existe e vai cobrar isso sozinha.

### 4.3 Chamador

`cleanOldNoteDetails` continua agendada no cron diário
([`cronService.js`](../../services/cronService.js)). Nenhuma mudança: a função
passa a retornar cedo, e o log diz por quê.

## 5. Testes (`node --test`)

Baseline em 28/08/2026: **662 testes / 45 suites / 0 falhas**.

1. `NOTE_DETAILS_RETENTION_DAYS` ausente → nenhum `delete` é emitido.
2. `= 0` → idem (0 é "ilimitado", não "apaga tudo" — a confusão que mais
   assusta neste tipo de flag).
3. `= '90'` (string, como vem do `.env`) → cutoff igual a `dateBRTMinusDays(90)`.
4. Valor inválido (`'abc'`, negativo) → trata como ilimitado, não como 0 dias.
   **Este é o teste que importa:** o modo de falha catastrófico é um valor
   ruim virar "apague tudo".
5. `.env.example` documenta a chave com aviso destrutivo (já coberto pelo
   teste existente, que passa a valer para a chave nova).

## 6. Verificação em produção

Depois do deploy, na madrugada seguinte:

```bash
grep clean_note_details ~/prod-stc/logs/out.log | tail -3
```

Aceite: linha `clean_note_details_skipped` com `retencao ilimitada`. E, uma semana
depois, `min(fetched_at)` em `note_details` tem de continuar recuando (hoje
28/05/2026) em vez de andar para frente.

```bash
psql -d wpa_monitor -c "SELECT min(fetched_at)::date, count(*) FROM note_details;"
```

## 7. Não-objetivos (YAGNI)

- **Não** criar tabelas derivadas (`note_fatos`, `note_checkpoints`). Ver D4.
- **Não** recuperar os ~19 dias já apagados. Não é possível.
- **Não** mexer na retenção de `snapshots`.
- **Não** construir as sub-abas (Deslocamento Elevado / TMA). Esta spec só
  garante que o dado delas exista; elas são o ciclo seguinte.
- **Não** enxugar o payload. 3,58 KB/nota já cabe; otimizar agora seria trabalho
  sem problema.

## 8. Dívida que esta mudança CONGELA (e é consciente)

Reter para sempre significa reter os defeitos para sempre. Dois, já mapeados:

**8.1 Fuso corrompido nos payloads antigos.** A EDP entrega `ConclusionDate2`
com `-03:00` colado numa string UTC sem converter — instante 3h adiantado
(probe de 08/06/2026, documentado em
[`notaProcessor.js`](../../services/notaProcessor.js)). Payloads gravados antes
de 08/06/2026 têm o valor **errado dentro do jsonb**; o conserto
(`fixCachedPayloadTz`) roda só na **leitura**. Como o mais antigo vivo é 28/05,
são ~11 dias de payloads que passam a ser guardados torto para sempre.

Não é bloqueante — as colunas derivadas do TMA vão receber o valor já corrigido
em JS. Mas **qualquer consulta SQL nova que leia `payload->'datas'->>'conclusao'`
cru vai errar por 3h**, e isso precisa estar escrito onde alguém veja. Decidir na
rodada das abas: normalizar de vez, ou proibir leitura crua.

⚠️ Cuidado relacionado: `snapshots[].conclusionDate` usa
`ConclusionDate2 || ConclusionDate` ([`wpaService.js`](../../services/wpaService.js)),
ou seja, **prefere** o campo que o `notaProcessor` proíbe. As duas fontes de
"conclusão" podem divergir. Não misturar sem antes provar que são o mesmo
instante.

**8.2 Consulta em jsonb não escala.** Ler datas de anos de notas via
`payload->'datas'->>...` repete o problema que custou 8s no passo 1 da aba
Deslocamento em 28/08/2026, resolvido lá com a coluna indexada `first_cp_at`. O
TMA vai precisar do mesmo tratamento. Entra no ciclo das abas.

## 9. Rollback

`git revert` de um commit. A mudança é uma guarda aditiva: sem ela, o
comportamento volta a ser o de hoje (TTL de 90 dias). Sem schema, sem migração,
sem dado reescrito.

Se algum dia o disco apertar, o botão existe e não precisa de deploy:

```bash
echo 'NOTE_DETAILS_RETENTION_DAYS=180' >> ~/prod-stc/.env
pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
```

## 10. Riscos

- **Crescimento de disco.** Mitigado pela medição da §2 (~8 anos de folga) e pelo
  botão de reversão acima. Vale incluir `note_details` em qualquer alerta de
  disco que o P1-1 (watchdog) venha a ter.
- **Backup.** O P0-2 (backup offsite) fica ~1,15 GB/ano mais pesado. Não é
  bloqueante, mas quem for dimensionar o offsite precisa saber.
- **A tabela fica grande e alguém "otimiza".** Mitigado pelo comentário no
  código e por esta spec: a próxima pessoa que olhar `note_details` com 500 mil
  linhas precisa encontrar o porquê antes de propor limpeza.
