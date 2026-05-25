-- 009_osrm_cache.sql
-- Cache de consultas ao OSRM (Open Source Routing Machine) pra estimar
-- tempo/distância de deslocamentos das equipes em campo.
--
-- Política: pra cada par (origem → destino) consultamos UMA vez e cacheamos.
-- Re-consultar o mesmo par é desperdício — a malha viária do OSM não muda
-- minuto a minuto. Cache é evergreen; refresh manual via admin se necessário.
--
-- A chave é determinística: hash MD5 dos 4 coords arredondados a 5 casas
-- decimais (~1m de precisão). Isso evita explosão de cache por jitter de GPS.

CREATE TABLE IF NOT EXISTS osrm_cache (
  cache_key     TEXT          PRIMARY KEY,            -- md5(o_lat:o_lng:d_lat:d_lng)
  origin_lat    NUMERIC(10,7) NOT NULL,
  origin_lng    NUMERIC(10,7) NOT NULL,
  dest_lat      NUMERIC(10,7) NOT NULL,
  dest_lng      NUMERIC(10,7) NOT NULL,
  duration_sec  INTEGER       NOT NULL,               -- segundos estimados
  distance_m    INTEGER       NOT NULL,               -- metros
  geometry      JSONB,                                -- polyline encodado/decodado pra desenhar no mapa
  source        TEXT          DEFAULT 'osrm_public',  -- caso troquemos pra outro provedor
  fetched_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Lookup por par origem/destino é via PK, mas índices secundários ajudam
-- queries diagnósticas (ex: "todos cálculos de origem X")
CREATE INDEX IF NOT EXISTS idx_osrm_origin ON osrm_cache (origin_lat, origin_lng);
CREATE INDEX IF NOT EXISTS idx_osrm_fetched ON osrm_cache (fetched_at);
