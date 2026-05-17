/**
 * Composite trust score + tier mapping. Spec §10.
 *
 * Inputs come from the `ratings` table aggregate columns:
 *   - account_age_days        (derived from profiles.created_at)
 *   - paid_games_completed
 *   - paid_games_abandoned
 *   - refunds_filed
 *   - refunds_granted
 *   - refunds_denied
 *   - fairplay_flags          (confirmed only — pending flags don't count)
 *   - kyc_status              (none | pending | approved | rejected)
 *
 * Output is an integer 0..100 plus a tier label. The tier thresholds
 * are spec §10 — adjust constants here if the spec moves.
 *
 * Pure; no DB. Caller fetches inputs and persists outputs.
 */

export type TrustTier = 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface TrustInputs {
  accountAgeDays: number;
  paidGamesCompleted: number;
  paidGamesAbandoned: number;
  refundsFiled: number;
  refundsGranted: number;
  refundsDenied: number;
  fairplayFlagsConfirmed: number;
  kycStatus: 'none' | 'pending' | 'approved' | 'rejected';
}

export interface TrustResult {
  score: number;
  tier: TrustTier;
  /** Per-component contributions, for debugging + admin UI. */
  components: {
    base: number;
    accountAge: number;
    matches: number;
    abandonRate: number;
    refundRate: number;
    fairplay: number;
    kyc: number;
  };
}

const TIER_THRESHOLDS: Array<{ tier: TrustTier; minScore: number }> = [
  { tier: 'platinum', minScore: 90 },
  { tier: 'gold', minScore: 75 },
  { tier: 'silver', minScore: 55 },
  { tier: 'bronze', minScore: 35 },
  { tier: 'new', minScore: 0 },
];

export function tierFromScore(score: number): TrustTier {
  for (const t of TIER_THRESHOLDS) {
    if (score >= t.minScore) return t.tier;
  }
  return 'new';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Composite trust score. Each component contributes a bounded number of
 * points; the total is clamped to 0..100 so spam in any one dimension
 * cannot dominate.
 *
 * Component budgets (max contribution):
 *   base                     50  — every account starts above zero
 *   accountAge               10  — saturates at 90 days
 *   matches                  15  — saturates at 50 completed matches
 *   abandonRate             −15  — penalty proportional to share of abandons
 *   refundRate              −10  — penalty for over-filing without grant
 *   fairplay                −50  — confirmed engine use crashes the score
 *   kyc                     +10  — verified identity adds trust
 */
export function computeTrustScore(inputs: TrustInputs): TrustResult {
  const base = 50;
  const accountAge = clamp(inputs.accountAgeDays / 90, 0, 1) * 10;
  const matches = clamp(inputs.paidGamesCompleted / 50, 0, 1) * 15;

  const totalPaid = inputs.paidGamesCompleted + inputs.paidGamesAbandoned;
  const abandonRate = totalPaid > 0 ? inputs.paidGamesAbandoned / totalPaid : 0;
  const abandonPenalty = -clamp(abandonRate, 0, 1) * 15;

  // A user filing many refunds with few granted is suspicious. We only
  // penalize when grants are LOW relative to filings; legit refund
  // requests that are approved don't hurt the user.
  const refundPenalty =
    inputs.refundsFiled > 0
      ? -clamp(
          (inputs.refundsFiled - inputs.refundsGranted) / Math.max(1, inputs.refundsFiled),
          0,
          1,
        ) * 10
      : 0;

  // Each CONFIRMED fairplay flag is a step toward bottom. Capped at 50
  // points of penalty so a single flag isn't immediately a permaban.
  const fairplay = -clamp(inputs.fairplayFlagsConfirmed * 25, 0, 50);

  const kyc = inputs.kycStatus === 'approved' ? 10 : 0;

  const total = base + accountAge + matches + abandonPenalty + refundPenalty + fairplay + kyc;
  const score = Math.round(clamp(total, 0, 100));
  return {
    score,
    tier: tierFromScore(score),
    components: {
      base,
      accountAge,
      matches,
      abandonRate: abandonPenalty,
      refundRate: refundPenalty,
      fairplay,
      kyc,
    },
  };
}

/**
 * Action gates. The tier gate decides which behaviors a profile may take.
 * Spec §10 + §12.
 *
 * The wallet hold-period table is in apps/web/lib/ledger.ts —
 * walletHoldPeriodDays(tier).
 */
export interface TierGates {
  canCreatePaidChallenges: boolean;
  canAcceptPaidChallenges: boolean;
  /** Max single-challenge fee in cents. Spec §10 caps low-tier exposure. */
  maxChallengeFeeCents: number;
  /** Days until paid earnings clear for withdrawal. */
  withdrawHoldDays: number;
  /** Can publicly list in /sparring opt-in panel. */
  canListInSparring: boolean;
}

export function tierGates(tier: TrustTier): TierGates {
  switch (tier) {
    case 'new':
      return {
        canCreatePaidChallenges: false,
        canAcceptPaidChallenges: true,
        maxChallengeFeeCents: 0,
        withdrawHoldDays: 5,
        canListInSparring: false,
      };
    case 'bronze':
      return {
        canCreatePaidChallenges: true,
        canAcceptPaidChallenges: true,
        maxChallengeFeeCents: 500,
        withdrawHoldDays: 5,
        canListInSparring: true,
      };
    case 'silver':
      return {
        canCreatePaidChallenges: true,
        canAcceptPaidChallenges: true,
        maxChallengeFeeCents: 2_000,
        withdrawHoldDays: 3,
        canListInSparring: true,
      };
    case 'gold':
      return {
        canCreatePaidChallenges: true,
        canAcceptPaidChallenges: true,
        maxChallengeFeeCents: 10_000,
        withdrawHoldDays: 1,
        canListInSparring: true,
      };
    case 'platinum':
      return {
        canCreatePaidChallenges: true,
        canAcceptPaidChallenges: true,
        maxChallengeFeeCents: 50_000,
        withdrawHoldDays: 0,
        canListInSparring: true,
      };
  }
}
