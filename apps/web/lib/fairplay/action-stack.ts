/**
 * Action stack — maps a confirmed fairplay flag severity to the
 * corresponding ban_actions row and side-effects.
 *
 * Spec §12 ladder:
 *   1 → warning, logged
 *   2 → paid-play suspended 7 days
 *   3 → paid-play suspended 30 days
 *   4 → paid-play permanently suspended
 *   5 → full account suspended 30 days
 *   6 → permanent ban + earnings forfeit
 *
 * Pure function. Caller persists the BanActionPlan into `ban_actions`
 * and triggers the listed side-effects.
 */

export type Severity = 1 | 2 | 3 | 4 | 5 | 6;

export type SideEffect =
  | 'cancel_open_challenges'
  | 'cancel_pending_invitations'
  | 'freeze_wallet'
  | 'forfeit_pending_balance'
  | 'invalidate_sessions';

export interface BanActionPlan {
  severity: Severity;
  description: string;
  /** ban_actions.expires_at — null = permanent. */
  expiresAt: string | null;
  sideEffects: SideEffect[];
}

const DAYS_MS = 24 * 60 * 60 * 1000;

export function planForSeverity(severity: Severity, now: Date = new Date()): BanActionPlan {
  switch (severity) {
    case 1:
      return {
        severity,
        description: 'Warning — logged, no restriction',
        expiresAt: null,
        sideEffects: [],
      };
    case 2:
      return {
        severity,
        description: 'Paid-play suspended 7 days',
        expiresAt: new Date(now.getTime() + 7 * DAYS_MS).toISOString(),
        sideEffects: ['cancel_open_challenges', 'cancel_pending_invitations'],
      };
    case 3:
      return {
        severity,
        description: 'Paid-play suspended 30 days',
        expiresAt: new Date(now.getTime() + 30 * DAYS_MS).toISOString(),
        sideEffects: ['cancel_open_challenges', 'cancel_pending_invitations'],
      };
    case 4:
      return {
        severity,
        description: 'Paid-play permanently suspended',
        expiresAt: null,
        sideEffects: ['cancel_open_challenges', 'cancel_pending_invitations'],
      };
    case 5:
      return {
        severity,
        description: 'Full account suspended 30 days',
        expiresAt: new Date(now.getTime() + 30 * DAYS_MS).toISOString(),
        sideEffects: [
          'cancel_open_challenges',
          'cancel_pending_invitations',
          'freeze_wallet',
          'invalidate_sessions',
        ],
      };
    case 6:
      return {
        severity,
        description: 'Permanent ban + earnings forfeit',
        expiresAt: null,
        sideEffects: [
          'cancel_open_challenges',
          'cancel_pending_invitations',
          'freeze_wallet',
          'forfeit_pending_balance',
          'invalidate_sessions',
        ],
      };
  }
}
