/**
 * Typed analytics event registry (spec §23). Drives PostHog capture +
 * Metabase funnels.
 *
 * Every event has:
 *   - a stable string name (snake_case, never renamed once shipped)
 *   - a properties type — strongly enforced at the capture call site
 *
 * Sentry init lives in initSentry(); we don't import @sentry/nextjs at
 * the top because not every runtime needs it (the workers package has
 * its own init). Callers do `await initSentry()` in their bootstrap.
 */

export type AnalyticsEvent =
  | {
      name: 'signup_completed';
      properties: { method: 'email' | 'google'; referredBy: string | null };
    }
  | { name: 'external_account_linked'; properties: { platform: 'lichess' | 'chess.com' } }
  | {
      name: 'prep_report_started';
      properties: { opponentPlatform: 'lichess' | 'chess.com'; opponentHandle: string };
    }
  | { name: 'prep_report_viewed'; properties: { reportId: string; viaShareLink: boolean } }
  | {
      name: 'challenge_published';
      properties: {
        challengeId: string;
        timeClass: string;
        feeCents: number;
        fundingType: 'cash' | 'credits';
      };
    }
  | { name: 'challenge_accepted'; properties: { challengeId: string; matchId: string } }
  | {
      name: 'match_completed';
      properties: { matchId: string; result: '1-0' | '0-1' | '1/2-1/2'; durationMs: number };
    }
  | { name: 'refund_filed'; properties: { matchId: string; reasonCode: string } }
  | { name: 'withdrawal_initiated'; properties: { amountCents: number; currency: string } }
  | { name: 'subscription_started'; properties: { plan: string; currency: string } };

export type AnalyticsEventName = AnalyticsEvent['name'];

export interface AnalyticsTransport {
  capture: (args: {
    distinctId: string;
    event: AnalyticsEventName;
    properties: Record<string, unknown>;
  }) => void;
}

let transport: AnalyticsTransport | null = null;

export function setAnalyticsTransport(t: AnalyticsTransport | null): void {
  transport = t;
}

function getPosthogTransport(): AnalyticsTransport | null {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST ?? 'https://app.posthog.com';
  if (!apiKey) return null;
  return {
    capture(args) {
      // Fire-and-forget — analytics writes must never block a user request.
      // We swallow errors and rely on Sentry to capture failures at the
      // fetch layer when the transport actually has problems.
      void fetch(`${host}/capture/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          distinct_id: args.distinctId,
          event: args.event,
          properties: { ...args.properties, $lib: 'chessco-web' },
        }),
      }).catch(() => undefined);
    },
  };
}

function resolveTransport(): AnalyticsTransport | null {
  if (transport) return transport;
  const ph = getPosthogTransport();
  if (ph) {
    transport = ph;
    return ph;
  }
  return null;
}

/**
 * Type-safe capture. The event union forces callers to provide the right
 * properties for each event name; renaming/dropping a property elsewhere
 * is a compile error.
 */
export function captureEvent(distinctId: string, event: AnalyticsEvent): void {
  const t = resolveTransport();
  if (!t) return;
  t.capture({
    distinctId,
    event: event.name,
    properties: event.properties as Record<string, unknown>,
  });
}

/**
 * Sentry initialization shim. Calling this on a runtime that doesn't have
 * @sentry/nextjs installed is a no-op — callers shouldn't have to gate.
 *
 * Production wiring: install @sentry/nextjs at apps/web, configure
 * SENTRY_DSN, and replace the dynamic import below with a static import
 * in next.config.ts (or use the Sentry wizard).
 */
export async function initSentry(): Promise<{ initialized: boolean }> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return { initialized: false };
  try {
    // Dynamic import through a string variable so TS treats it as a true
    // runtime specifier (no type checking, no @ts-ignore needed). The
    // package is an optional peer dep; this module compiles + builds even
    // when @sentry/nextjs isn't installed.
    const sentrySpec = '@sentry/nextjs';
    const sentryMod = (await import(sentrySpec).catch(() => null)) as {
      init: (opts: { dsn: string; tracesSampleRate: number }) => void;
    } | null;
    if (!sentryMod) return { initialized: false };
    sentryMod.init({ dsn, tracesSampleRate: 0.1 });
    return { initialized: true };
  } catch {
    return { initialized: false };
  }
}
