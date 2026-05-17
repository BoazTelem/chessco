/**
 * Drizzle ORM schema for Chessco — mirrors the SQL in packages/db/migrations/.
 *
 * The SQL migrations are the source of truth for what lives in the DB. This
 * file gives the TypeScript app type-safe references to those tables. Keep
 * the two in lockstep when adding/changing columns.
 *
 * Per spec §5 v1.1. Organized by domain via comment-banners.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// Reusable column factories
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const pkUuid = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const pkBigserial = () => bigserial('id', { mode: 'number' }).primaryKey();

// ============================================================================
// IDENTITY & ACCOUNTS
// ============================================================================

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  username: text('username').unique(),
  displayName: text('display_name'),
  email: text('email').unique(),
  avatarUrl: text('avatar_url'),
  country: text('country'),
  city: text('city'),
  dateOfBirth: date('date_of_birth'),
  chessTitle: text('chess_title'),
  bio: text('bio'),
  preferredLanguage: text('preferred_language').default('en'),
  marketingConsent: boolean('marketing_consent').default(false),
  isVerified: boolean('is_verified').default(false),
  kycStatus: text('kyc_status')
    .$type<'none' | 'pending' | 'approved' | 'rejected'>()
    .default('none'),
  stripeAccountId: text('stripe_account_id'),
  stripeCustomerId: text('stripe_customer_id'),
  profileVisibility: text('profile_visibility')
    .$type<'public' | 'private' | 'coach_public_player_private'>()
    .notNull()
    .default('public'),
  referralCode: text('referral_code').notNull().unique(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  lastSeenAt: timestamptz('last_seen_at'),
  deletedAt: timestamptz('deleted_at'),
});

export type ProfileVisibility = 'public' | 'private' | 'coach_public_player_private';

export const externalAccounts = pgTable(
  'external_accounts',
  {
    id: pkUuid(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    platform: text('platform')
      .$type<'lichess' | 'chess.com' | 'fide' | 'chess-results'>()
      .notNull(),
    externalId: text('external_id').notNull(),
    externalUrl: text('external_url'),
    verified: boolean('verified').default(false),
    confidenceScore: numeric('confidence_score'),
    ratingBlitz: integer('rating_blitz'),
    ratingRapid: integer('rating_rapid'),
    ratingClassical: integer('rating_classical'),
    ratingBullet: integer('rating_bullet'),
    lastSyncedAt: timestamptz('last_synced_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_accounts_platform_external_id_key').on(t.platform, t.externalId),
    index('external_accounts_profile_id_idx').on(t.profileId),
  ],
);

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: pkUuid(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    token: text('token').notNull().unique(),
    consumed: boolean('consumed').default(false),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('verification_tokens_profile_id_idx').on(t.profileId)],
);

// ============================================================================
// FEDERATIONS & OFFICIAL RATING LISTS
// ============================================================================

export const federations = pgTable('federations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  country: text('country'),
  // Added 2026-05-14 (Phase 0 W7 full-sweep expansion, migration 0032):
  iso2: char('iso2', { length: 2 }),
  iso3: char('iso3', { length: 3 }),
  continent: text('continent').$type<'AF' | 'AS' | 'EU' | 'NA' | 'OC' | 'SA'>(),
  scrapeStrategy: text('scrape_strategy').$type<
    'dump' | 'fetch-html' | 'aspnet' | 'spa' | 'api' | 'cloudflare' | 'placeholder'
  >(),
  estPlayerCount: integer('est_player_count'),
  notes: text('notes'),
  ratingListUrl: text('rating_list_url'),
  ratingListFormat: text('rating_list_format').$type<'xml' | 'csv' | 'json' | 'html'>(),
  syncCadence: text('sync_cadence').$type<'monthly' | 'quarterly' | 'semi_annual' | 'manual'>(),
  lastSyncedAt: timestamptz('last_synced_at'),
  active: boolean('active').default(true),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const federationPlayers = pgTable(
  'federation_players',
  {
    id: pkUuid(),
    federationId: text('federation_id')
      .notNull()
      .references(() => federations.id, { onDelete: 'restrict' }),
    federationPlayerId: text('federation_player_id').notNull(),
    name: text('name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    country: text('country'),
    birthYear: integer('birth_year'),
    gender: char('gender', { length: 1 }).$type<'M' | 'F'>(),
    title: text('title'),
    ratingStandard: integer('rating_standard'),
    ratingRapid: integer('rating_rapid'),
    ratingBlitz: integer('rating_blitz'),
    ratingQuick: integer('rating_quick'),
    playerId: uuid('player_id'),
    lastUpdatedAt: timestamptz('last_updated_at').notNull().defaultNow(),
    removedFromListAt: timestamptz('removed_from_list_at'),
    raw: jsonb('raw'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('federation_players_federation_id_federation_player_id_key').on(
      t.federationId,
      t.federationPlayerId,
    ),
  ],
);

export const federationRatingSnapshots = pgTable('federation_rating_snapshots', {
  id: pkBigserial(),
  federationPlayerId: uuid('federation_player_id')
    .notNull()
    .references(() => federationPlayers.id, { onDelete: 'cascade' }),
  snapshotDate: date('snapshot_date').notNull(),
  ratingStandard: integer('rating_standard'),
  ratingRapid: integer('rating_rapid'),
  ratingBlitz: integer('rating_blitz'),
  title: text('title'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// ============================================================================
// PLAYERS
// ============================================================================

export const players = pgTable('players', {
  id: pkUuid(),
  canonicalName: text('canonical_name'),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
  country: text('country'),
  fideId: text('fide_id'),
  peakRating: integer('peak_rating'),
  embedding: vector('embedding', { dimensions: 384 }),
  // Right-to-delist (spec §6 privacy). When non-null, the player's profile
  // and aliases are excluded from /scout results, /p/[id] returns 404, and
  // the embedding is null-cleared in the next aggregate recompute. The
  // canonical row itself stays for audit + deduplication.
  delistedAt: timestamptz('delisted_at'),
  delistReason: text('delist_reason'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const playerAliases = pgTable('player_aliases', {
  id: pkUuid(),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  handle: text('handle').notNull(),
  confidence: numeric('confidence'),
  source: text('source').$type<'verified' | 'manual' | 'inferred'>(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// ============================================================================
// GAMES, POSITIONS, MOVES
// ============================================================================

export const games = pgTable(
  'games',
  {
    id: pkUuid(),
    source: text('source')
      .$type<'lichess' | 'chess.com' | 'upload' | 'fide' | 'pgn_import'>()
      .notNull(),
    sourceGameId: text('source_game_id').notNull(),
    whitePlayerId: uuid('white_player_id').references(() => players.id, { onDelete: 'set null' }),
    blackPlayerId: uuid('black_player_id').references(() => players.id, { onDelete: 'set null' }),
    whiteHandleSnapshot: text('white_handle_snapshot'),
    blackHandleSnapshot: text('black_handle_snapshot'),
    whiteRating: integer('white_rating'),
    blackRating: integer('black_rating'),
    pgn: text('pgn').notNull(),
    initialFen: text('initial_fen'),
    result: text('result').$type<'1-0' | '0-1' | '1/2-1/2' | '*'>(),
    termination: text('termination'),
    timeControl: text('time_control'),
    timeClass: text('time_class').$type<
      'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence'
    >(),
    openingEco: text('opening_eco'),
    openingName: text('opening_name'),
    plyCount: integer('ply_count'),
    playedAt: timestamptz('played_at'),
    importedAt: timestamptz('imported_at').notNull().defaultNow(),
    rawMeta: jsonb('raw_meta'),
  },
  (t) => [
    uniqueIndex('games_source_source_game_id_key').on(t.source, t.sourceGameId),
    index('games_played_at_idx').on(t.playedAt),
  ],
);

export const positions = pgTable('positions', {
  id: pkBigserial(),
  fen: text('fen').notNull().unique(),
  fenHash: bigint('fen_hash', { mode: 'bigint' }).notNull().unique(),
  sideToMove: char('side_to_move', { length: 1 }).$type<'w' | 'b'>(),
  ply: integer('ply'),
  eco: text('eco'),
  openingName: text('opening_name'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const moves = pgTable(
  'moves',
  {
    id: pkBigserial(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    ply: integer('ply').notNull(),
    san: text('san').notNull(),
    uci: text('uci').notNull(),
    fenBeforeId: bigint('fen_before_id', { mode: 'number' })
      .notNull()
      .references(() => positions.id),
    fenAfterId: bigint('fen_after_id', { mode: 'number' })
      .notNull()
      .references(() => positions.id),
    clockWhiteMs: integer('clock_white_ms'),
    clockBlackMs: integer('clock_black_ms'),
    evalBeforeCp: integer('eval_before_cp'),
    evalAfterCp: integer('eval_after_cp'),
    evalBeforeMate: integer('eval_before_mate'),
    evalAfterMate: integer('eval_after_mate'),
    cpLoss: integer('cp_loss'),
    isBookMove: boolean('is_book_move').default(false),
    isBlunder: boolean('is_blunder').default(false),
    isMistake: boolean('is_mistake').default(false),
    isInaccuracy: boolean('is_inaccuracy').default(false),
  },
  (t) => [index('moves_game_id_ply_idx').on(t.gameId, t.ply)],
);

// ============================================================================
// PER-PLAYER AGGREGATES
// ============================================================================

export const playerPositionStats = pgTable('player_position_stats', {
  id: pkBigserial(),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  positionId: bigint('position_id', { mode: 'number' })
    .notNull()
    .references(() => positions.id),
  color: char('color', { length: 1 }).$type<'w' | 'b'>().notNull(),
  gamesCount: integer('games_count').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  draws: integer('draws').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  avgCpLossNextMove: numeric('avg_cp_loss_next_move'),
  blunderRate: numeric('blunder_rate'),
  lastSeenAt: timestamptz('last_seen_at'),
});

export const playerOpeningStats = pgTable('player_opening_stats', {
  id: pkBigserial(),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  positionId: bigint('position_id', { mode: 'number' })
    .notNull()
    .references(() => positions.id),
  color: char('color', { length: 1 }).$type<'w' | 'b'>().notNull(),
  nextMoveUci: text('next_move_uci').notNull(),
  nextMoveSan: text('next_move_san').notNull(),
  gamesCount: integer('games_count').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  draws: integer('draws').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  avgCpLoss: numeric('avg_cp_loss'),
});

export const styleFeatures = pgTable('style_features', {
  playerId: uuid('player_id')
    .primaryKey()
    .references(() => players.id, { onDelete: 'cascade' }),
  features: jsonb('features').notNull(),
  computedAt: timestamptz('computed_at').notNull().defaultNow(),
  gamesWindow: integer('games_window').notNull(),
});

// ============================================================================
// IDENTIFICATION QUERIES & CANDIDATES
// ============================================================================

export const identificationQueries = pgTable('identification_queries', {
  id: pkUuid(),
  requestedBy: uuid('requested_by')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  queryPayload: jsonb('query_payload').notNull(),
  status: text('status').$type<'pending' | 'ready' | 'failed'>().notNull().default('pending'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  completedAt: timestamptz('completed_at'),
});

export const identificationCandidates = pgTable('identification_candidates', {
  id: pkBigserial(),
  queryId: uuid('query_id')
    .notNull()
    .references(() => identificationQueries.id, { onDelete: 'cascade' }),
  rank: integer('rank').notNull(),
  federationPlayerId: uuid('federation_player_id').references(() => federationPlayers.id, {
    onDelete: 'set null',
  }),
  playerId: uuid('player_id').references(() => players.id, { onDelete: 'set null' }),
  confidenceLabel: text('confidence_label').$type<'high' | 'medium' | 'low'>(),
  combinedScore: numeric('combined_score'),
  anchorScore: numeric('anchor_score'),
  handleScore: numeric('handle_score'),
  styleScore: numeric('style_score'),
  evidence: jsonb('evidence'),
  userConfirmed: boolean('user_confirmed'),
  userFeedback: text('user_feedback').$type<
    'correct' | 'probably_correct' | 'probably_wrong' | 'wrong'
  >(),
  userFeedbackBy: uuid('user_feedback_by').references(() => profiles.id, { onDelete: 'set null' }),
  userFeedbackAt: timestamptz('user_feedback_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const identificationCandidateFeedback = pgTable(
  'identification_candidate_feedback',
  {
    id: pkBigserial(),
    candidateId: bigint('candidate_id', { mode: 'number' })
      .notNull()
      .references(() => identificationCandidates.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    feedback: text('feedback')
      .$type<'correct' | 'probably_correct' | 'probably_wrong' | 'wrong'>()
      .notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    candidateUserUnique: uniqueIndex('identification_candidate_feedback_candidate_user_idx').on(
      table.candidateId,
      table.userId,
    ),
    candidateIdx: index('identification_candidate_feedback_candidate_idx').on(table.candidateId),
    valueIdx: index('identification_candidate_feedback_value_idx').on(table.feedback),
  }),
);

// ============================================================================
// PREP REPORTS
// ============================================================================

export const prepReports = pgTable('prep_reports', {
  id: pkUuid(),
  requestedBy: uuid('requested_by')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  userPlayerId: uuid('user_player_id').references(() => players.id, { onDelete: 'set null' }),
  targetPlayerId: uuid('target_player_id')
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  status: text('status')
    .$type<'pending' | 'building' | 'data_pending' | 'ready' | 'failed'>()
    .notNull()
    .default('pending'),
  summary: text('summary'),
  recommendedWhiteLines: jsonb('recommended_white_lines'),
  recommendedBlackLines: jsonb('recommended_black_lines'),
  avoidLines: jsonb('avoid_lines'),
  practicePositions: jsonb('practice_positions'),
  rawFindings: jsonb('raw_findings'),
  pdfUrl: text('pdf_url'),
  targetPlatform: text('target_platform').$type<'lichess' | 'chess.com'>(),
  targetHandleNormalized: text('target_handle_normalized'),
  leaksJson: jsonb('leaks_json'),
  errorText: text('error_text'),
  // Share token: when non-null, /reports/[id]?t=<token> bypasses the
  // owner-only auth check. The owner mints/rotates/revokes via
  // POST/DELETE /api/prepare/reports/[id]/share. Stored as a short
  // hex string; collision-resistant per crypto.randomUUID().
  shareToken: text('share_token'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  completedAt: timestamptz('completed_at'),
  expiresAt: timestamptz('expires_at'),
});

export const prepLeakUnlocks = pgTable(
  'prep_leak_unlocks',
  {
    id: pkUuid(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    targetPlatform: text('target_platform').$type<'lichess' | 'chess.com'>().notNull(),
    targetHandleNormalized: text('target_handle_normalized').notNull(),
    leakFingerprint: text('leak_fingerprint').notNull(),
    prepReportId: uuid('prep_report_id').references(() => prepReports.id, {
      onDelete: 'set null',
    }),
    costCredits: integer('cost_credits').$type<0 | 1>().notNull(),
    unlockedAt: timestamptz('unlocked_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('prep_leak_unlocks_user_opp_fp_key').on(
      t.profileId,
      t.targetPlatform,
      t.targetHandleNormalized,
      t.leakFingerprint,
    ),
    index('prep_leak_unlocks_user_opp_idx').on(
      t.profileId,
      t.targetPlatform,
      t.targetHandleNormalized,
      t.unlockedAt,
    ),
  ],
);

// ============================================================================
// MARKETPLACE
// ============================================================================

export const challenges = pgTable('challenges', {
  id: pkUuid(),
  creatorId: uuid('creator_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  fen: text('fen').notNull(),
  pgnPrefix: text('pgn_prefix'),
  creatorColor: char('creator_color', { length: 1 }).$type<'w' | 'b'>(),
  timeControl: text('time_control').notNull(),
  timeClass: text('time_class').$type<'bullet' | 'blitz' | 'rapid' | 'classical'>().notNull(),
  feeCents: integer('fee_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  ratingMin: integer('rating_min'),
  ratingMax: integer('rating_max'),
  requiredTrustScore: integer('required_trust_score').default(50),
  gamesRequested: integer('games_requested').notNull().default(1),
  gamesCompleted: integer('games_completed').notNull().default(0),
  status: text('status')
    .$type<'open' | 'matched' | 'completed' | 'cancelled' | 'expired'>()
    .notNull()
    .default('open'),
  expiresAt: timestamptz('expires_at'),
  notes: text('notes'),
  openingName: text('opening_name'),
  ecoCode: text('eco_code'),
  anonymous: boolean('anonymous').notNull().default(false),
  creatorRating: integer('creator_rating'),
  fundingType: text('funding_type').$type<'cash' | 'credits'>().notNull().default('cash'),
  creditCost: integer('credit_cost').notNull().default(0),
  lastHeartbeat: timestamptz('last_heartbeat').notNull().defaultNow(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// ============================================================================
// MARKETPLACE — INVITATIONS + SPARRING PROFILE
// (Spec §8: /sparring directory + private-challenge invitations.)
// ============================================================================

export const challengeInvitations = pgTable('challenge_invitations', {
  id: pkUuid(),
  challengeId: uuid('challenge_id')
    .notNull()
    .references(() => challenges.id, { onDelete: 'cascade' }),
  inviterId: uuid('inviter_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  inviteeId: uuid('invitee_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  status: text('status')
    .$type<'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired'>()
    .notNull()
    .default('pending'),
  // Optional free-text note from the inviter (capped to 280 chars at the
  // route layer; column allows longer for migration headroom).
  message: text('message'),
  respondedAt: timestamptz('responded_at'),
  expiresAt: timestamptz('expires_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const playerSparringProfiles = pgTable('player_sparring_profiles', {
  // 1:1 with profiles — primary key IS the profile id so upsert is by-id.
  profileId: uuid('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  // Public opt-in: when false, this profile does NOT appear in /sparring.
  optedIn: boolean('opted_in').notNull().default(false),
  // Display blurb (~140 chars, route-enforced).
  bio: text('bio'),
  // Away-until: when in the future, /sparring banners the player as away
  // and the suggested-players ranker drops their priority. Spec §8.
  awayUntil: timestamptz('away_until'),
  // Cached "last seen online" so /sparring can sort by recency without a
  // realtime presence subscription on the public directory page.
  lastOnlineAt: timestamptz('last_online_at'),
  // Aggregate fields used by the suggested-players ranker (refreshed by
  // background job; no FK to ratings so we can null safely).
  glickoRating: integer('glicko_rating'),
  completedMatches: integer('completed_matches').notNull().default(0),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const playerSparringFees = pgTable(
  'player_sparring_fees',
  {
    id: pkUuid(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    timeClass: text('time_class').$type<'bullet' | 'blitz' | 'rapid' | 'classical'>().notNull(),
    feeCents: integer('fee_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    // Some players accept credits-only matches; some require cash. Spec
    // §8 "per-time-class fees" — this column lets the UI render either.
    fundingType: text('funding_type')
      .$type<'cash' | 'credits' | 'either'>()
      .notNull()
      .default('either'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    // One row per (profile, time_class) — a player publishes one fee per
    // category. UNIQUE so upsert-by-(profile,time_class) works.
    profileTimeClassUnique: uniqueIndex('player_sparring_fees_profile_time_class_unique').on(
      t.profileId,
      t.timeClass,
    ),
  }),
);

export type MatchStatus =
  | 'accepted'
  | 'starting'
  | 'live'
  | 'completed'
  | 'aborted'
  | 'abandoned'
  | 'creator_abandoned'
  | 'disputed'
  | 'settled';

export const matches = pgTable('matches', {
  id: pkUuid(),
  challengeId: uuid('challenge_id')
    .notNull()
    .references(() => challenges.id, { onDelete: 'cascade' }),
  opponentId: uuid('opponent_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'restrict' }),
  creatorId: uuid('creator_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'restrict' }),
  feeCents: integer('fee_cents').notNull(),
  platformFeeCents: integer('platform_fee_cents').notNull(),
  opponentPayoutCents: integer('opponent_payout_cents').notNull(),
  status: text('status').$type<MatchStatus>().notNull().default('accepted'),
  acceptedAt: timestamptz('accepted_at').notNull().defaultNow(),
  startedAt: timestamptz('started_at'),
  completedAt: timestamptz('completed_at'),
  settledAt: timestamptz('settled_at'),
  gameId: uuid('game_id'),
  reviewWindowExpiresAt: timestamptz('review_window_expires_at'),
});

export const liveGames = pgTable('live_games', {
  id: pkUuid(),
  matchId: uuid('match_id')
    .notNull()
    .unique()
    .references(() => matches.id, { onDelete: 'cascade' }),
  whiteUserId: uuid('white_user_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'restrict' }),
  blackUserId: uuid('black_user_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'restrict' }),
  initialFen: text('initial_fen').notNull(),
  pgn: text('pgn'),
  currentFen: text('current_fen'),
  timeControl: text('time_control').notNull(),
  whiteTimeMs: integer('white_time_ms'),
  blackTimeMs: integer('black_time_ms'),
  result: text('result').$type<'1-0' | '0-1' | '1/2-1/2' | '*'>(),
  termination: text('termination'),
  status: text('status')
    .$type<'live' | 'completed' | 'aborted' | 'abandoned'>()
    .notNull()
    .default('live'),
  startedAt: timestamptz('started_at').notNull().defaultNow(),
  completedAt: timestamptz('completed_at'),
});

export const matchMoves = pgTable('match_moves', {
  id: pkBigserial(),
  matchId: uuid('match_id')
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  ply: integer('ply').notNull(),
  san: text('san').notNull(),
  uci: text('uci').notNull(),
  timeRemainingMs: integer('time_remaining_ms'),
  clientTimestamp: timestamptz('client_timestamp'),
  serverTimestamp: timestamptz('server_timestamp').notNull().defaultNow(),
});

// ============================================================================
// WALLET & LEDGER
// ============================================================================

export const wallets = pgTable('wallets', {
  id: pkUuid(),
  profileId: uuid('profile_id')
    .notNull()
    .unique()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  availableCents: integer('available_cents').notNull().default(0),
  pendingCents: integer('pending_cents').notNull().default(0),
  creditAvailable: integer('credit_available').notNull().default(0),
  creditPending: integer('credit_pending').notNull().default(0),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const creditLedgerEntries = pgTable(
  'credit_ledger_entries',
  {
    id: pkUuid(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    direction: char('direction', { length: 1 }).$type<'D' | 'C'>().notNull(),
    amount: integer('amount').notNull(),
    category: text('category')
      .$type<
        | 'link_bonus'
        | 'challenge_reserve'
        | 'challenge_refund'
        | 'challenge_consume'
        | 'manual_adjustment'
        | 'referral_bonus'
        | 'prep_leak_reveal'
        | 'practice_reward'
        | 'subscription_grant'
        | 'cycle_expiry'
      >()
      .notNull(),
    referenceType: text('reference_type').$type<
      'external_account' | 'challenge' | 'match' | 'manual' | 'profile' | 'prep_leak_unlock'
    >(),
    referenceId: text('reference_id'),
    counterpartProfileId: uuid('counterpart_profile_id').references(() => profiles.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('credit_ledger_entries_profile_idx').on(t.profileId, t.createdAt)],
);

export const creditGrants = pgTable(
  'credit_grants',
  {
    id: pkUuid(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    sourceType: text('source_type')
      .$type<
        | 'external_account_link'
        | 'manual'
        | 'referral'
        | 'practice_reward'
        | 'subscription'
        | 'signup_bonus'
      >()
      .notNull(),
    sourceId: text('source_id').notNull(),
    amount: integer('amount').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_grants_profile_source_key').on(t.profileId, t.sourceType, t.sourceId),
    index('credit_grants_profile_idx').on(t.profileId, t.createdAt),
  ],
);

export const referrals = pgTable(
  'referrals',
  {
    id: pkUuid(),
    referrerProfileId: uuid('referrer_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    referredProfileId: uuid('referred_profile_id')
      .notNull()
      .unique()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    referralCode: text('referral_code').notNull(),
    status: text('status').$type<'pending' | 'credited' | 'rejected'>().notNull(),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    creditedAt: timestamptz('credited_at'),
  },
  (t) => [index('referrals_referrer_idx').on(t.referrerProfileId)],
);

export const ledgerEntries = pgTable('ledger_entries', {
  id: pkUuid(),
  transactionId: uuid('transaction_id').notNull(),
  accountType: text('account_type')
    .$type<'user_wallet' | 'platform_revenue' | 'escrow' | 'stripe_clearing' | 'refund_reserve'>()
    .notNull(),
  accountId: uuid('account_id'),
  direction: char('direction', { length: 1 }).$type<'D' | 'C'>().notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  category: text('category')
    .$type<
      | 'deposit'
      | 'match_escrow'
      | 'match_payout'
      | 'platform_fee'
      | 'withdrawal'
      | 'refund'
      | 'reversal'
    >()
    .notNull(),
  referenceType: text('reference_type').$type<'match' | 'stripe_payment' | 'payout' | 'manual'>(),
  referenceId: text('reference_id'),
  reversibleUntil: timestamptz('reversible_until'),
  reversedBy: uuid('reversed_by'),
  metadata: jsonb('metadata'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  processed: boolean('processed').default(false),
  processedAt: timestamptz('processed_at'),
  receivedAt: timestamptz('received_at').notNull().defaultNow(),
});

// ============================================================================
// RATING & TRUST
// ============================================================================

export const ratings = pgTable('ratings', {
  profileId: uuid('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  skillRating: numeric('skill_rating').notNull().default('1500'),
  skillRd: numeric('skill_rd').notNull().default('350'),
  skillVolatility: numeric('skill_volatility').notNull().default('0.06'),
  trustScore: integer('trust_score').notNull().default(50),
  trustTier: text('trust_tier')
    .$type<'new' | 'bronze' | 'silver' | 'gold' | 'platinum'>()
    .notNull()
    .default('new'),
  paidGamesCompleted: integer('paid_games_completed').notNull().default(0),
  paidGamesAbandoned: integer('paid_games_abandoned').notNull().default(0),
  refundsFiled: integer('refunds_filed').notNull().default(0),
  refundsGranted: integer('refunds_granted').notNull().default(0),
  refundsDenied: integer('refunds_denied').notNull().default(0),
  fairplayFlags: integer('fairplay_flags').notNull().default(0),
  lastRecalculatedAt: timestamptz('last_recalculated_at').notNull().defaultNow(),
});

/**
 * Per-time-class Glicko-2 ratings (spec §9). The aggregate `ratings`
 * table above keeps the legacy single-rating column for backwards
 * compatibility; this table is the canonical source for per-time-class
 * skill and ships in WS-9.
 *
 * Primary key is composite (profile_id, time_class) so the matcher and
 * trust-tier logic can fetch a player's rating for the time class they
 * are about to play without joining or coalescing nulls.
 */
export const ratingsByTimeClass = pgTable(
  'ratings_by_time_class',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    timeClass: text('time_class').$type<'bullet' | 'blitz' | 'rapid' | 'classical'>().notNull(),
    rating: numeric('rating').notNull().default('1500'),
    rd: numeric('rd').notNull().default('350'),
    volatility: numeric('volatility').notNull().default('0.06'),
    gamesPlayed: integer('games_played').notNull().default(0),
    lastUpdatedAt: timestamptz('last_updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.timeClass] })],
);

export const ratingHistory = pgTable('rating_history', {
  id: pkBigserial(),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  matchId: uuid('match_id').references(() => matches.id, { onDelete: 'set null' }),
  skillRatingBefore: numeric('skill_rating_before'),
  skillRatingAfter: numeric('skill_rating_after'),
  trustScoreBefore: integer('trust_score_before'),
  trustScoreAfter: integer('trust_score_after'),
  reason: text('reason'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// ============================================================================
// REFUNDS
// ============================================================================

export type RefundReasonCode =
  | 'opponent_abandoned'
  | 'opponent_didnt_play_position'
  | 'engine_assistance_suspected'
  | 'harassment'
  | 'technical_failure'
  | 'other';

export const refundRequests = pgTable('refund_requests', {
  id: pkUuid(),
  matchId: uuid('match_id')
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  requesterId: uuid('requester_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  respondentId: uuid('respondent_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'restrict' }),
  reasonCode: text('reason_code').$type<RefundReasonCode>().notNull(),
  reasonDetail: text('reason_detail'),
  evidence: jsonb('evidence'),
  status: text('status')
    .$type<'open' | 'auto_approved' | 'under_review' | 'approved' | 'denied' | 'reversed'>()
    .notNull()
    .default('open'),
  amountCents: integer('amount_cents').notNull(),
  resolutionNotes: text('resolution_notes'),
  resolvedBy: uuid('resolved_by'),
  autoResolutionRule: text('auto_resolution_rule'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  resolvedAt: timestamptz('resolved_at'),
});

// ============================================================================
// BAN ACTIONS (spec §12 severity 1–6 ladder)
// ============================================================================

export const banActions = pgTable('ban_actions', {
  id: pkUuid(),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  // Spec §12 severity ladder: 1 = warning (logged), 2 = paid-play suspended
  // 7 days, 3 = paid-play suspended 30 days, 4 = paid-play permanently
  // suspended, 5 = full account suspended 30 days, 6 = permanent ban +
  // earnings forfeit.
  severity: integer('severity').notNull(),
  reason: text('reason').notNull(),
  // Free-text + structured evidence (engine correlation IDs, telemetry
  // refs, manual report ids).
  evidence: jsonb('evidence'),
  // Recipient of forfeited earnings, when severity = 6. NULL if no
  // forfeit, or if forfeit went to platform_revenue.
  forfeitTransactionId: uuid('forfeit_transaction_id'),
  appliedBy: uuid('applied_by').references(() => profiles.id, { onDelete: 'set null' }),
  expiresAt: timestamptz('expires_at'),
  reversedAt: timestamptz('reversed_at'),
  reversedBy: uuid('reversed_by').references(() => profiles.id, { onDelete: 'set null' }),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// ============================================================================
// COACH ↔ STUDENT (spec §6 Phase 6 — stub for migration headroom)
// ============================================================================

export const coachStudents = pgTable(
  'coach_students',
  {
    id: pkUuid(),
    coachProfileId: uuid('coach_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    studentProfileId: uuid('student_profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    status: text('status').$type<'pending' | 'active' | 'ended'>().notNull().default('pending'),
    invitedAt: timestamptz('invited_at').notNull().defaultNow(),
    acceptedAt: timestamptz('accepted_at'),
    endedAt: timestamptz('ended_at'),
  },
  (t) => [
    uniqueIndex('coach_students_pair_unique').on(t.coachProfileId, t.studentProfileId),
    index('coach_students_coach_idx').on(t.coachProfileId),
    index('coach_students_student_idx').on(t.studentProfileId),
  ],
);

// ============================================================================
// MAIA WEIGHTS (spec §6 Phase 6 — per-player style-mimicking bots)
// ============================================================================

/**
 * One row per (target_profile, training_run). Real weights binary lives in
 * Supabase Storage; this row carries the metadata + storage URL + status
 * so the inference worker can fetch the latest ready weights for a player.
 */
export const maiaWeights = pgTable(
  'maia_weights',
  {
    id: pkUuid(),
    // The player whose style this Maia variant mimics. Can be a Chessco
    // profile or an external account (one of the two must be set).
    targetProfileId: uuid('target_profile_id').references(() => profiles.id, {
      onDelete: 'set null',
    }),
    targetPlayerId: uuid('target_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    // Base Maia model the fine-tune started from (e.g. 'maia-1500',
    // 'maia-1900'). Used to render "trained from" UI.
    baseModel: text('base_model').notNull(),
    version: text('version').notNull(),
    status: text('status')
      .$type<'queued' | 'training' | 'ready' | 'failed' | 'deprecated'>()
      .notNull()
      .default('queued'),
    // Supabase Storage URL of the trained weights. NULL while training.
    weightsUrl: text('weights_url'),
    // Hash of the training dataset (game IDs + timestamps) so re-runs can
    // skip when nothing changed.
    datasetHash: text('dataset_hash'),
    trainingGamesCount: integer('training_games_count'),
    trainingStartedAt: timestamptz('training_started_at'),
    trainingFinishedAt: timestamptz('training_finished_at'),
    errorText: text('error_text'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('maia_weights_target_profile_idx').on(t.targetProfileId, t.status),
    index('maia_weights_target_player_idx').on(t.targetPlayerId, t.status),
  ],
);

// ============================================================================
// ANTI-CHEAT
// ============================================================================

export const fairplayFlags = pgTable('fairplay_flags', {
  id: pkUuid(),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  matchId: uuid('match_id').references(() => matches.id, { onDelete: 'set null' }),
  gameId: uuid('game_id').references(() => games.id, { onDelete: 'set null' }),
  flagType: text('flag_type')
    .$type<
      'engine_correlation' | 'tab_switching' | 'time_pattern' | 'manual_report' | 'sandbagging'
    >()
    .notNull(),
  severity: integer('severity').notNull(),
  signals: jsonb('signals'),
  reviewedBy: uuid('reviewed_by'),
  outcome: text('outcome').$type<'confirmed' | 'dismissed' | 'pending'>().default('pending'),
  actionTaken: text('action_taken').$type<'none' | 'warning' | 'paid_play_suspended' | 'banned'>(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  reviewedAt: timestamptz('reviewed_at'),
});

export const fairplayTelemetry = pgTable('fairplay_telemetry', {
  id: pkBigserial(),
  matchId: uuid('match_id')
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  eventType: text('event_type')
    .$type<'tab_blur' | 'tab_focus' | 'mouse_idle' | 'paste_detected' | 'devtools_open'>()
    .notNull(),
  eventData: jsonb('event_data'),
  clientTimestamp: timestamptz('client_timestamp'),
  serverTimestamp: timestamptz('server_timestamp').notNull().defaultNow(),
});

// ============================================================================
// AUDIT & ADMIN
// ============================================================================

export const auditLogs = pgTable('audit_logs', {
  id: pkBigserial(),
  actorType: text('actor_type').$type<'user' | 'admin' | 'system'>().notNull(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const adminUsers = pgTable('admin_users', {
  profileId: uuid('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  role: text('role').$type<'support' | 'moderator' | 'admin' | 'finance'>().notNull(),
  permissions: jsonb('permissions'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// ============================================================================
// PRACTICE PREFERENCES (per-user board/sound/piece settings for live games)
// ============================================================================

export type BoardTheme = 'classic' | 'wood' | 'green' | 'blue' | 'gray';
export type PieceSet = 'cburnett' | 'merida' | 'alpha' | 'staunton';

export const userPracticePrefs = pgTable('user_practice_prefs', {
  profileId: uuid('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  boardTheme: text('board_theme').$type<BoardTheme>().notNull().default('classic'),
  pieceSet: text('piece_set').$type<PieceSet>().notNull().default('cburnett'),
  soundEnabled: boolean('sound_enabled').notNull().default(true),
  animationsEnabled: boolean('animations_enabled').notNull().default(true),
  premovesEnabled: boolean('premoves_enabled').notNull().default(true),
  autoPromoteQueen: boolean('auto_promote_queen').notNull().default(false),
  showLegalMoves: boolean('show_legal_moves').notNull().default(true),
  showCoordinates: boolean('show_coordinates').notNull().default(true),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// ============================================================================
// INFERRED TYPES (handy aliases for app code)
// ============================================================================

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type ExternalAccount = typeof externalAccounts.$inferSelect;
export type Federation = typeof federations.$inferSelect;
export type FederationPlayer = typeof federationPlayers.$inferSelect;
export type Player = typeof players.$inferSelect;
export type Game = typeof games.$inferSelect;
export type Move = typeof moves.$inferSelect;
export type IdentificationQuery = typeof identificationQueries.$inferSelect;
export type IdentificationCandidate = typeof identificationCandidates.$inferSelect;
export type PrepReport = typeof prepReports.$inferSelect;
export type NewPrepReport = typeof prepReports.$inferInsert;
export type PrepLeakUnlock = typeof prepLeakUnlocks.$inferSelect;
export type NewPrepLeakUnlock = typeof prepLeakUnlocks.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type ChallengeInvitation = typeof challengeInvitations.$inferSelect;
export type NewChallengeInvitation = typeof challengeInvitations.$inferInsert;
export type PlayerSparringProfile = typeof playerSparringProfiles.$inferSelect;
export type NewPlayerSparringProfile = typeof playerSparringProfiles.$inferInsert;
export type PlayerSparringFee = typeof playerSparringFees.$inferSelect;
export type NewPlayerSparringFee = typeof playerSparringFees.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type LiveGame = typeof liveGames.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type Rating = typeof ratings.$inferSelect;
export type RatingByTimeClass = typeof ratingsByTimeClass.$inferSelect;
export type NewRatingByTimeClass = typeof ratingsByTimeClass.$inferInsert;
export type RefundRequest = typeof refundRequests.$inferSelect;
export type FairplayFlag = typeof fairplayFlags.$inferSelect;
export type BanAction = typeof banActions.$inferSelect;
export type NewBanAction = typeof banActions.$inferInsert;
export type CoachStudent = typeof coachStudents.$inferSelect;
export type NewCoachStudent = typeof coachStudents.$inferInsert;
export type MaiaWeights = typeof maiaWeights.$inferSelect;
export type NewMaiaWeights = typeof maiaWeights.$inferInsert;
export type UserPracticePrefs = typeof userPracticePrefs.$inferSelect;
export type NewUserPracticePrefs = typeof userPracticePrefs.$inferInsert;
