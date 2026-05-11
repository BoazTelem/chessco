// Drizzle schema + migrations live here.
// Phase 0 Week 2 populates the full schema per spec §5 v1.1, including:
//   - profiles, external_accounts, verification_tokens
//   - federations, federation_players, federation_rating_snapshots (FIDE anchor)
//   - players, player_aliases, games (partitioned by played_at month), positions, moves
//   - player_position_stats, player_opening_stats, style_features
//   - identification_queries, identification_candidates
//   - prep_reports
//   - challenges, matches, live_games, match_moves
//   - wallets, ledger_entries, stripe_events
//   - ratings, rating_history
//   - refund_requests, fairplay_flags, fairplay_telemetry
//   - audit_logs, admin_users
// Plus: pg_trgm + pgvector extensions, RLS on every table, GIN trigram index on
// federation_players.name_normalized, HNSW vector index on players.embedding (Phase 2).
// Phase 0 stub for now.

export const schemaVersion = '0.0.0' as const;

export type SchemaVersion = typeof schemaVersion;
