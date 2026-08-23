-- 013_escala_dia.sql
-- Escala CADASTRADA por dia, por colaborador.
--
-- CONTEXTO (P2-24 / P1-26, 22/08/2026). `/admin/health` monta
-- `teams_missing_today` iterando a whitelist inteira e marcando quem não está em
-- `teams_current`, SEM cruzar com escala — então equipe de folga, férias ou
-- afastamento aparece como "não logou" todo dia. Falso positivo diário, e o
-- diagnóstico do P2-24 era exatamente este: não havia onde guardar a escala.
--
-- O que existia: um turno ESTÁTICO por equipe (`equipes_oficiais.escala_inicio/
-- escala_fim`), que além de não distinguir folga de falta é UPDATE in-place —
-- mudar o turno hoje reescreve o "atrasou para logar" de todos os dias passados.
--
-- Fonte: GET /api/collaboratorshifts/{setor}/{mes}/{ano}, 1 request por setor/mês.
-- Populada por services/cronService.js (runSyncEscalaDia), diariamente às 05:20 e
-- sob demanda via POST /api/admin/sync-escala-dia.
--
-- GRÃO: colaborador, não equipe. O P2-24 propunha
-- `escala_dia(setor, equipe, data, codigo_escala, ...)`, mas dois colaboradores da
-- MESMA equipe podem ter códigos diferentes no mesmo dia (um em FOL, outro em
-- T07). No grão da equipe isso se perde e "a equipe estava escalada?" fica
-- ambíguo. A visão de equipe é derivada em services/escalaDia.classificarDia:
-- escalada = algum colaborador com código de trabalho.
--
-- Códigos que NÃO são dia trabalhado (services/escalaDia.ESCALA_NAO_TRABALHADA):
--   FOL, DR, DES, FER, DIS, AFO, NA, SAV, SIN, TRE

CREATE TABLE IF NOT EXISTS escala_dia (
  data                DATE        NOT NULL,
  sector_id           TEXT        NOT NULL,   -- DESG | DEPT | DESC | DSSJ
  equipe              TEXT        NOT NULL,   -- Data[].Name
  colaborador_codigo  TEXT        NOT NULL,   -- Collaborators[].Code; '' quando a EDP não manda
  colaborador_nome    TEXT,
  codigo_escala       TEXT        NOT NULL,   -- Scale[].ScaleCategoryName, ex.: 'T07 07:00', 'FOL'
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (data, sector_id, equipe, colaborador_codigo)
);

-- A consulta quente é "a escala de HOJE" — a PK já começa por data, então ela
-- cobre o filtro. Índice extra só para o caso de varrer uma equipe no tempo.
CREATE INDEX IF NOT EXISTS idx_escala_dia_equipe ON escala_dia (equipe, data);

COMMENT ON TABLE escala_dia IS
  'Escala cadastrada por dia e por colaborador (GET /api/collaboratorshifts). '
  'Populada por cronService.runSyncEscalaDia. Base do P1-26: "não logou" passa a '
  'significar "estava escalada e não logou".';

COMMENT ON COLUMN escala_dia.colaborador_codigo IS
  'Matrícula. NOT NULL com string vazia como valor de ausência, porque é parte '
  'da PK — nulo em PK impediria o upsert idempotente do cron.';

-- Owner do app: o psql da VM roda como usr_jose, mas a aplicação conecta como
-- wpa_app. Guardado por IF EXISTS porque em máquina de desenvolvimento a role
-- não existe e um ALTER solto abortaria a migration inteira. Ver 012 e o RUNBOOK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wpa_app') THEN
    EXECUTE 'ALTER TABLE escala_dia OWNER TO wpa_app';
  END IF;
END $$;
