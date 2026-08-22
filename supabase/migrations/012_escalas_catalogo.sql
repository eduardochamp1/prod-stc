-- 012_escalas_catalogo.sql
-- Catálogo de turnos da EDP: a definição de cada código de escala.
--
-- CONTEXTO (22/08/2026). Comparando a nossa integração com os outros três
-- projetos da empresa que consomem a mesma API WPA (GQO, SJC e o ES legado),
-- apareceu um endpoint que nós não usávamos:
--
--   GET /api/scaletypes/matches?sectorId={X}
--
-- Ele devolve, por setor, a definição de cada turno: horário de entrada, janela
-- de intervalo prevista, saída, e o ciclo de dias trabalhados/de folga.
--
-- Por que isso importa: o comentário em services/cronService.js (runSyncEscalas)
-- afirmava "o WPA não informa o fim do turno", e por causa dessa premissa
-- services/wpaService.js INFERIA fim = início + 9h (8h de trabalho + 1h de
-- refeição) — e o cron gravava esse valor inferido em `equipes_oficiais.escala_fim`,
-- que é tabela de negócio. A premissa era falsa. Desde 22/08/2026 o fim vem do
-- catálogo, e o +9h ficou só como fallback para turno que a EDP não cataloga.
--
-- Esta tabela existe para três coisas:
--   1. auditabilidade — dá pra conferir de onde veio o `escala_fim` de cada equipe;
--   2. habilitar o P1-26 — `dias_trabalhados`/`dias_nao_trabalhados` são o que
--      falta para distinguir FOLGA de FALTA no "equipe não logou", hoje um falso
--      positivo diário;
--   3. habilitar o P2-15 — `inicio_intervalo`/`fim_intervalo` são o lado
--      "previsto" da comparação com o intervalo realizado.
--
-- Populada por services/cronService.js (runSyncEscalaCatalogo), no mesmo gancho
-- do sync de escalas. O código tolera a ausência da tabela: se a migration não
-- rodou, loga um aviso e segue — o painel não depende dela.

CREATE TABLE IF NOT EXISTS escalas_catalogo (
  codigo                  TEXT        NOT NULL,   -- scaletypes.Code, ex.: 'T07 07:00'
  sector_id               TEXT        NOT NULL,   -- DESG | DEPT | DESC | DSSJ
  descricao               TEXT,                   -- scaletypes.Description
  inicio_escala           TIME,                   -- StartTime
  inicio_intervalo        TIME,                   -- StartIntervalTime
  fim_intervalo           TIME,                   -- EndIntervalTime
  fim_escala              TIME,                   -- EndTime  ← o que a gente inferia
  dias_trabalhados        INTEGER,                -- WorkDays
  dias_nao_trabalhados    INTEGER,                -- DaysOff
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (codigo, sector_id)
);

-- O acesso é sempre "os turnos deste setor".
CREATE INDEX IF NOT EXISTS idx_escalas_catalogo_setor ON escalas_catalogo (sector_id);

COMMENT ON TABLE escalas_catalogo IS
  'Catálogo de turnos da EDP (GET /api/scaletypes/matches?sectorId=). Populado '
  'por cronService.runSyncEscalaCatalogo. Fonte do fim REAL do turno, que antes '
  'de 22/08/2026 era inferido como inicio+9h. Habilita P1-26 e P2-15.';

COMMENT ON COLUMN escalas_catalogo.fim_escala IS
  'Fim real do turno, direto da EDP. Substitui a inferência inicio+9h que era '
  'gravada em equipes_oficiais.escala_fim.';
