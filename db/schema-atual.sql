--
-- PostgreSQL database dump
--

\restrict OrkMtdnlc557wbPxva4EGqwebnRE4TEYaBBOmjNzwLi1Yricpssq7oqy1OlzRsd

-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_subcat_totals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_subcat_totals (
    id bigint NOT NULL,
    date date NOT NULL,
    regional text NOT NULL,
    tipo text NOT NULL,
    sub_code text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    quantidade numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_subcat_totals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_subcat_totals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_subcat_totals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_subcat_totals_id_seq OWNED BY public.daily_subcat_totals.id;


--
-- Name: daily_totals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_totals (
    id bigint NOT NULL,
    date date NOT NULL,
    regional text NOT NULL,
    tipo_code text NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: daily_totals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_totals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_totals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_totals_id_seq OWNED BY public.daily_totals.id;


--
-- Name: equipes_oficiais; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipes_oficiais (
    sigla text NOT NULL,
    regional text NOT NULL,
    tipo text NOT NULL,
    placa text,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    setor text NOT NULL,
    escala_inicio time without time zone,
    escala_fim time without time zone,
    CONSTRAINT equipes_oficiais_regional_check CHECK ((regional = ANY (ARRAY['GUA'::text, 'CAC'::text, 'SJC'::text]))),
    CONSTRAINT equipes_oficiais_setor_check CHECK ((setor = ANY (ARRAY['DESG'::text, 'DEPT'::text, 'DESC'::text, 'DSSJ'::text])))
);


--
-- Name: metas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metas (
    regional text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: notas_daily_agg; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notas_daily_agg (
    data date NOT NULL,
    equipe text NOT NULL,
    pendentes_fim_dia integer DEFAULT 0 NOT NULL,
    entraram_no_dia integer DEFAULT 0 NOT NULL,
    sairam_no_dia integer DEFAULT 0 NOT NULL,
    idade_mais_antiga_dias integer DEFAULT 0 NOT NULL,
    regional text DEFAULT 'GUA'::text NOT NULL
);


--
-- Name: notas_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notas_snapshots (
    snapshot_ts timestamp with time zone NOT NULL,
    nota_number text NOT NULL,
    nota_id uuid,
    tipo text,
    equipe text NOT NULL,
    status integer,
    conclusion_date timestamp with time zone,
    conclusion_status text,
    sap_message text,
    equipe_oficial boolean DEFAULT true NOT NULL,
    regional text
);


--
-- Name: note_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_details (
    note_id uuid NOT NULL,
    numero text,
    tipo text,
    sector_id text,
    payload jsonb NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: note_rejections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_rejections (
    note_id uuid NOT NULL,
    numero text,
    tipo text NOT NULL,
    team_name text NOT NULL,
    regional text NOT NULL,
    sector_id text,
    rejection_date timestamp with time zone,
    session_date date NOT NULL,
    observacao text,
    motivo_codes text[] DEFAULT '{}'::text[] NOT NULL,
    motivo_textos text[] DEFAULT '{}'::text[] NOT NULL,
    formulario text,
    collaborator_codes text[] DEFAULT '{}'::text[] NOT NULL,
    collaborator_names text[] DEFAULT '{}'::text[] NOT NULL,
    raw jsonb,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: note_subcategorias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_subcategorias (
    note_id uuid NOT NULL,
    numero text,
    tipo text NOT NULL,
    sub_code text NOT NULL,
    sub_categoria text NOT NULL,
    code text,
    code_text text,
    quantidade numeric,
    classified_at timestamp with time zone DEFAULT now() NOT NULL,
    raw jsonb
);


--
-- Name: osrm_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.osrm_cache (
    cache_key text NOT NULL,
    origin_lat numeric(10,7) NOT NULL,
    origin_lng numeric(10,7) NOT NULL,
    dest_lat numeric(10,7) NOT NULL,
    dest_lng numeric(10,7) NOT NULL,
    duration_sec integer NOT NULL,
    distance_m integer NOT NULL,
    geometry jsonb,
    source text DEFAULT 'osrm_public'::text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshots (
    id bigint NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    date date NOT NULL,
    team_name text NOT NULL,
    sector_id text NOT NULL,
    regional text NOT NULL,
    session_begin text,
    session_end text,
    vehicle_plate text,
    baixadas integer DEFAULT 0 NOT NULL,
    executadas integer DEFAULT 0 NOT NULL,
    concluidas integer DEFAULT 0 NOT NULL,
    rejeitadas integer DEFAULT 0 NOT NULL,
    data jsonb
);


--
-- Name: snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.snapshots_id_seq OWNED BY public.snapshots.id;


--
-- Name: team_daily_carteira; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_daily_carteira (
    date date NOT NULL,
    team_name text NOT NULL,
    regional text,
    carteira_inicial integer DEFAULT 0 NOT NULL,
    entradas_novas integer DEFAULT 0 NOT NULL,
    atual integer DEFAULT 0 NOT NULL,
    andamento integer DEFAULT 0 NOT NULL,
    concluidas integer DEFAULT 0 NOT NULL,
    rejeitadas integer DEFAULT 0 NOT NULL,
    canceladas integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_daily_subcat_totals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_daily_subcat_totals (
    id bigint NOT NULL,
    date date NOT NULL,
    team_name text NOT NULL,
    regional text NOT NULL,
    sector_id text NOT NULL,
    tipo text NOT NULL,
    sub_code text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    quantidade numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_daily_subcat_totals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.team_daily_subcat_totals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: team_daily_subcat_totals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.team_daily_subcat_totals_id_seq OWNED BY public.team_daily_subcat_totals.id;


--
-- Name: team_daily_totals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_daily_totals (
    id bigint NOT NULL,
    date date NOT NULL,
    team_name text NOT NULL,
    regional text NOT NULL,
    sector_id text NOT NULL,
    tipo_code text NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: team_daily_totals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.team_daily_totals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: team_daily_totals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.team_daily_totals_id_seq OWNED BY public.team_daily_totals.id;


--
-- Name: teams_current; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams_current (
    team_name text NOT NULL,
    regional text NOT NULL,
    sector_id text NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wpa_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wpa_token (
    key text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    user_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_subcat_totals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_subcat_totals ALTER COLUMN id SET DEFAULT nextval('public.daily_subcat_totals_id_seq'::regclass);


--
-- Name: daily_totals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_totals ALTER COLUMN id SET DEFAULT nextval('public.daily_totals_id_seq'::regclass);


--
-- Name: snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots ALTER COLUMN id SET DEFAULT nextval('public.snapshots_id_seq'::regclass);


--
-- Name: team_daily_subcat_totals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_daily_subcat_totals ALTER COLUMN id SET DEFAULT nextval('public.team_daily_subcat_totals_id_seq'::regclass);


--
-- Name: team_daily_totals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_daily_totals ALTER COLUMN id SET DEFAULT nextval('public.team_daily_totals_id_seq'::regclass);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: daily_subcat_totals daily_subcat_totals_date_regional_tipo_sub_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_subcat_totals
    ADD CONSTRAINT daily_subcat_totals_date_regional_tipo_sub_code_key UNIQUE (date, regional, tipo, sub_code);


--
-- Name: daily_subcat_totals daily_subcat_totals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_subcat_totals
    ADD CONSTRAINT daily_subcat_totals_pkey PRIMARY KEY (id);


--
-- Name: daily_totals daily_totals_date_regional_tipo_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_totals
    ADD CONSTRAINT daily_totals_date_regional_tipo_code_key UNIQUE (date, regional, tipo_code);


--
-- Name: daily_totals daily_totals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_totals
    ADD CONSTRAINT daily_totals_pkey PRIMARY KEY (id);


--
-- Name: equipes_oficiais equipes_oficiais_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipes_oficiais
    ADD CONSTRAINT equipes_oficiais_pkey PRIMARY KEY (sigla);


--
-- Name: metas metas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metas
    ADD CONSTRAINT metas_pkey PRIMARY KEY (regional);


--
-- Name: notas_daily_agg notas_daily_agg_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notas_daily_agg
    ADD CONSTRAINT notas_daily_agg_pkey PRIMARY KEY (data, equipe, regional);


--
-- Name: notas_snapshots notas_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notas_snapshots
    ADD CONSTRAINT notas_snapshots_pkey PRIMARY KEY (snapshot_ts, nota_number);


--
-- Name: note_details note_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_details
    ADD CONSTRAINT note_details_pkey PRIMARY KEY (note_id);


--
-- Name: note_rejections note_rejections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_rejections
    ADD CONSTRAINT note_rejections_pkey PRIMARY KEY (note_id);


--
-- Name: note_subcategorias note_subcategorias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_subcategorias
    ADD CONSTRAINT note_subcategorias_pkey PRIMARY KEY (note_id);


--
-- Name: osrm_cache osrm_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.osrm_cache
    ADD CONSTRAINT osrm_cache_pkey PRIMARY KEY (cache_key);


--
-- Name: snapshots snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_pkey PRIMARY KEY (id);


--
-- Name: team_daily_carteira team_daily_carteira_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_daily_carteira
    ADD CONSTRAINT team_daily_carteira_pkey PRIMARY KEY (date, team_name);


--
-- Name: team_daily_subcat_totals team_daily_subcat_totals_date_team_name_tipo_sub_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_daily_subcat_totals
    ADD CONSTRAINT team_daily_subcat_totals_date_team_name_tipo_sub_code_key UNIQUE (date, team_name, tipo, sub_code);


--
-- Name: team_daily_subcat_totals team_daily_subcat_totals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_daily_subcat_totals
    ADD CONSTRAINT team_daily_subcat_totals_pkey PRIMARY KEY (id);


--
-- Name: team_daily_totals team_daily_totals_date_team_name_tipo_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_daily_totals
    ADD CONSTRAINT team_daily_totals_date_team_name_tipo_code_key UNIQUE (date, team_name, tipo_code);


--
-- Name: team_daily_totals team_daily_totals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_daily_totals
    ADD CONSTRAINT team_daily_totals_pkey PRIMARY KEY (id);


--
-- Name: teams_current teams_current_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_current
    ADD CONSTRAINT teams_current_pkey PRIMARY KEY (team_name);


--
-- Name: wpa_token wpa_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wpa_token
    ADD CONSTRAINT wpa_token_pkey PRIMARY KEY (key);


--
-- Name: idx_daily_subcat_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_subcat_date ON public.daily_subcat_totals USING btree (date);


--
-- Name: idx_daily_subcat_regional_dt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_subcat_regional_dt ON public.daily_subcat_totals USING btree (regional, date);


--
-- Name: idx_daily_subcat_subcode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_subcat_subcode ON public.daily_subcat_totals USING btree (sub_code);


--
-- Name: idx_daily_totals_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_totals_date ON public.daily_totals USING btree (date);


--
-- Name: idx_equipes_oficiais_ativo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipes_oficiais_ativo ON public.equipes_oficiais USING btree (ativo);


--
-- Name: idx_equipes_oficiais_regional; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipes_oficiais_regional ON public.equipes_oficiais USING btree (regional);


--
-- Name: idx_equipes_oficiais_setor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipes_oficiais_setor ON public.equipes_oficiais USING btree (setor);


--
-- Name: idx_notas_daily_agg_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notas_daily_agg_data ON public.notas_daily_agg USING btree (data DESC);


--
-- Name: idx_notas_snapshots_equipe_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notas_snapshots_equipe_ts ON public.notas_snapshots USING btree (equipe, snapshot_ts DESC);


--
-- Name: idx_notas_snapshots_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notas_snapshots_number ON public.notas_snapshots USING btree (nota_number);


--
-- Name: idx_notas_snapshots_oficial; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notas_snapshots_oficial ON public.notas_snapshots USING btree (equipe_oficial, snapshot_ts DESC);


--
-- Name: idx_notas_snapshots_regional_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notas_snapshots_regional_ts ON public.notas_snapshots USING btree (regional, snapshot_ts DESC);


--
-- Name: idx_note_details_fetched_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_note_details_fetched_at ON public.note_details USING btree (fetched_at);


--
-- Name: idx_note_subcat_subcode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_note_subcat_subcode ON public.note_subcategorias USING btree (sub_code);


--
-- Name: idx_note_subcat_tipo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_note_subcat_tipo ON public.note_subcategorias USING btree (tipo);


--
-- Name: idx_osrm_fetched; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_osrm_fetched ON public.osrm_cache USING btree (fetched_at);


--
-- Name: idx_osrm_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_osrm_origin ON public.osrm_cache USING btree (origin_lat, origin_lng);


--
-- Name: idx_rej_collab_codes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rej_collab_codes ON public.note_rejections USING gin (collaborator_codes);


--
-- Name: idx_rej_motivo_codes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rej_motivo_codes ON public.note_rejections USING gin (motivo_codes);


--
-- Name: idx_rej_regional_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rej_regional_date ON public.note_rejections USING btree (regional, session_date);


--
-- Name: idx_rej_session_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rej_session_date ON public.note_rejections USING btree (session_date);


--
-- Name: idx_rej_team_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rej_team_date ON public.note_rejections USING btree (team_name, session_date);


--
-- Name: idx_rej_tipo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rej_tipo ON public.note_rejections USING btree (tipo);


--
-- Name: idx_snapshots_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_snapshots_captured_at ON public.snapshots USING btree (captured_at DESC);


--
-- Name: idx_snapshots_date_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_snapshots_date_team ON public.snapshots USING btree (date, team_name);


--
-- Name: idx_tdc_regional; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tdc_regional ON public.team_daily_carteira USING btree (regional, date);


--
-- Name: idx_team_daily_subcat_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_daily_subcat_date ON public.team_daily_subcat_totals USING btree (date);


--
-- Name: idx_team_daily_subcat_regional_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_daily_subcat_regional_date ON public.team_daily_subcat_totals USING btree (regional, date);


--
-- Name: idx_team_daily_subcat_subcode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_daily_subcat_subcode ON public.team_daily_subcat_totals USING btree (sub_code);


--
-- Name: idx_team_daily_subcat_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_daily_subcat_team ON public.team_daily_subcat_totals USING btree (team_name);


--
-- Name: idx_team_daily_totals_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_daily_totals_date ON public.team_daily_totals USING btree (date);


--
-- Name: idx_team_daily_totals_regional_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_daily_totals_regional_date ON public.team_daily_totals USING btree (regional, date);


--
-- Name: idx_team_daily_totals_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_daily_totals_team ON public.team_daily_totals USING btree (team_name);


--
-- Name: idx_wpa_token_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wpa_token_expires ON public.wpa_token USING btree (expires_at);


--
-- PostgreSQL database dump complete
--

\unrestrict OrkMtdnlc557wbPxva4EGqwebnRE4TEYaBBOmjNzwLi1Yricpssq7oqy1OlzRsd

