-- 015_supervisores.sql
-- Supervisor da equipe: catálogo + vínculo atual + histórico com vigência.
--
-- CONTEXTO (07/10/2026). José: "vamos criar uma coluna na lista de equipes onde
-- vamos adicionar o supervisor da equipe [...] adicionar mais um filtro de
-- supervisor [...] e futuramente medir a produtividade por supervisor."
--
-- Três decisões dele, que dão a forma deste arquivo:
--
--   1. CATÁLOGO (`supervisores`), não texto livre. Nome digitado em cada equipe
--      vira "JOAO" numa e "JOÃO SILVA" noutra, e a métrica por supervisor parte
--      a mesma pessoa em duas linhas sem ninguém perceber.
--
--   2. VIGÊNCIA (`equipe_supervisor_historico`). Quando a equipe troca de
--      supervisor, a produção ANTERIOR continua sendo do supervisor anterior.
--      Só a coluna `equipes_oficiais.supervisor_id` não basta: ela diz quem é
--      hoje, e a métrica futura atribuiria o passado inteiro ao supervisor
--      novo — número errado em relatório que a EDP pode auditar.
--
--   3. A coluna em `equipes_oficiais` continua existindo: é o estado ATUAL,
--      usado pelo filtro e pela tela de Admin sem precisar resolver vigência.
--      A rota PUT /admin/equipes/:sigla grava as duas coisas juntas.
--
-- Grão do histórico = DIA (`desde` DATE, dia BRT). As métricas do painel são
-- diárias; trocar duas vezes no mesmo dia guarda só a última (upsert em
-- (sigla, desde)). `supervisor_id` NULO numa linha = "sem supervisor a partir
-- desta data" — estado válido, não ausência de dado.
--
-- Supervisor nunca é apagado de verdade (`ativo = false`): o histórico aponta
-- pra ele, e apagar quebraria a atribuição retroativa.

CREATE TABLE IF NOT EXISTS supervisores (
  id          SERIAL      PRIMARY KEY,
  nome        TEXT        NOT NULL UNIQUE,   -- normalizado: MAIÚSCULAS, espaços simples
  ativo       BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE equipes_oficiais
  ADD COLUMN IF NOT EXISTS supervisor_id INTEGER REFERENCES supervisores(id);

CREATE TABLE IF NOT EXISTS equipe_supervisor_historico (
  sigla          TEXT        NOT NULL,
  desde          DATE        NOT NULL,       -- dia BRT a partir do qual vale
  supervisor_id  INTEGER     REFERENCES supervisores(id),   -- NULO = sem supervisor
  registrado_por TEXT,
  registrado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sigla, desde)
);

CREATE INDEX IF NOT EXISTS idx_equipe_sup_hist_supervisor
  ON equipe_supervisor_historico (supervisor_id, desde);

COMMENT ON TABLE supervisores IS
  'Catálogo de supervisores (015). Soft delete por ativo=false — o histórico aponta pra cá.';
COMMENT ON COLUMN equipes_oficiais.supervisor_id IS
  'Supervisor ATUAL. A atribuição por data mora em equipe_supervisor_historico.';
COMMENT ON TABLE equipe_supervisor_historico IS
  'Vigência do supervisor por equipe, grão dia. Base da futura produtividade por '
  'supervisor: cada dia é do supervisor vigente NAQUELE dia, não do atual.';

-- Owner do app. Ver 012, 013 e a seção "Aplicar uma migration" do RUNBOOK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wpa_app') THEN
    EXECUTE 'ALTER TABLE supervisores OWNER TO wpa_app';
    EXECUTE 'ALTER SEQUENCE supervisores_id_seq OWNER TO wpa_app';
    EXECUTE 'ALTER TABLE equipe_supervisor_historico OWNER TO wpa_app';
  END IF;
END $$;
