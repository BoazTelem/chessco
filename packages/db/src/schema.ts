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
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

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
    .$type<'pending' | 'building' | 'ready' | 'failed'>()
    .notNull()
    .default('pending'),
  summary: text('summary'),
  recommendedWhiteLines: jsonb('recommended_white_lines'),
  recommendedBlackLines: jsonb('recommended_black_lines'),
  avoidLines: jsonb('avoid_lines'),
  practicePositions: jsonb('practice_positions'),
  rawFindings: jsonb('raw_findings'),
  pdfUrl: text('pdf_url'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  completedAt: timestamptz('completed_at'),
  expiresAt: timestamptz('expires_at'),
});

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
      >()
      .notNull(),
    referenceType: text('reference_type').$type<
      'external_account' | 'challenge' | 'match' | 'manual' | 'profile'
    >(),
    referenceId: text('reference_id'),
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
      .$type<'external_account_link' | 'manual' | 'referral'>()
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
export type Challenge = typeof challenges.$inferSelect;
export type Match = typeof matches.$inferSelect;
export type LiveGame = typeof liveGames.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type Rating = typeof ratings.$inferSelect;
export type RefundRequest = typeof refundRequests.$inferSelect;
export type FairplayFlag = typeof fairplayFlags.$inferSelect;
export type UserPracticePrefs = typeof userPracticePrefs.$inferSelect;
export type NewUserPracticePrefs = typeof userPracticePrefs.$inferInsert;
