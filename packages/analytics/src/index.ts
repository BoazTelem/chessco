// Event tracking helpers (PostHog).
// The set of named events is the source of truth for product analytics
// per spec §23.

export type AnalyticsEvent =
  | 'signup_completed'
  | 'external_account_linked'
  | 'prep_report_started'
  | 'prep_report_viewed'
  | 'challenge_published'
  | 'challenge_accepted'
  | 'match_completed'
  | 'refund_filed'
  | 'withdrawal_initiated'
  | 'subscription_started';

export const ANALYTICS_EVENTS: readonly AnalyticsEvent[] = [
  'signup_completed',
  'external_account_linked',
  'prep_report_started',
  'prep_report_viewed',
  'challenge_published',
  'challenge_accepted',
  'match_completed',
  'refund_filed',
  'withdrawal_initiated',
  'subscription_started',
] as const;
