-- ============================================================================
-- chessco-games corpus — sparse-feature fingerprint storage
-- ============================================================================
-- v1 retrieval moves from linear-scan cosine in app code to a Postgres-native
-- sparse inverted index. Two complementary tables:
--
--   account_fingerprints  — denormalized per-handle scalar prefilter row
--                            (rating band, country, dominant time class,
--                            game window) for cheap WHERE-clause filtering
--                            and the frozen V0 JSONB summary for re-rank.
--
--   fingerprint_terms     — sparse weighted-term inverted index. One row per
--                            (handle, kind, term). Kinds: eco_w, eco_b,
--                            seq_w, seq_b, tc. Weight is the L1-normalised
--                            term frequency in that kind for that handle.
--                            Lookup pattern is point-query per (kind, term)
--                            with SUM(stored.weight * query.weight) over
--                            matching rows, top-K by score.
--
--   fingerprint_dirty_queue — incremental rebuild trigger. When a handle
--                            ingests new games, push a row here; a small
--                            worker drains the queue and recomputes the
--                            fingerprint + terms in one txn.
--
-- pgvector + HNSW are deferred to v2 when we have learned dense embeddings
-- (cross-platform sibling matching, neural style). Our hand-engineered
-- histograms are naturally sparse — composite B-tree on (kind, term) is
-- the right shape for the retrieval pattern.
--
-- style_features (migration 0001) is kept as the canonical V0 fingerprint
-- store; account_fingerprints is a denormalised prefilter helper; the new
-- worker upserts all three together.
-- ============================================================================

CREATE TABLE IF NOT EXISTS account_fingerprints (
  handle_id           uuid PRIMARY KEY REFERENCES handles(id) ON DELETE CASCADE,
  platform            text NOT NULL,
  handle              text NOT NULL,
  games_window        integer NOT NULL,
  median_rating       integer,
  rating_blitz        integer,
  rating_rapid        integer,
  rating_classical    integer,
  country             text,
  title               text,
  dominant_time_class text,
  white_share         numeric(4,3),
  earliest_played_at  timestamptz,
  latest_played_at    timestamptz,
  scalar_summary      jsonb NOT NULL,
  built_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_fingerprints_prefilter_idx
  ON account_fingerprints (dominant_time_class, median_rating)
  WHERE games_window >= 10;

CREATE INDEX IF NOT EXISTS account_fingerprints_platform_country_idx
  ON account_fingerprints (platform, country)
  WHERE games_window >= 10;

CREATE TABLE IF NOT EXISTS fingerprint_terms (
  handle_id  uuid    NOT NULL REFERENCES handles(id) ON DELETE CASCADE,
  kind       text    NOT NULL CHECK (kind IN ('eco_w','eco_b','seq_w','seq_b','tc')),
  term       text    NOT NULL,
  weight     real    NOT NULL,
  PRIMARY KEY (handle_id, kind, term)
);

CREATE INDEX IF NOT EXISTS fingerprint_terms_lookup_idx
  ON fingerprint_terms (kind, term);

CREATE TABLE IF NOT EXISTS fingerprint_dirty_queue (
  handle_id   uuid PRIMARY KEY REFERENCES handles(id) ON DELETE CASCADE,
  dirty_since timestamptz NOT NULL DEFAULT NOW(),
  reason      text
);

CREATE INDEX IF NOT EXISTS fingerprint_dirty_since_idx
  ON fingerprint_dirty_queue (dirty_since);

INSERT INTO games_corpus_migrations (id) VALUES ('0010_account_fingerprints');
