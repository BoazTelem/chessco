/**
 * Fire-and-forget logger for the /admin/super/searches audit feed.
 *
 * Records each user-driven search or find with:
 *   - profile_id when signed in
 *   - search_session_id from the cookie issued by middleware
 *   - HMAC(IP) + Vercel geo headers when we have a client IP
 *
 * Raw IPs are never persisted. Failure to log MUST NOT break the user flow,
 * so every step swallows errors with a console.error.
 */
import { createHmac } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { getPracticeDb } from '@/lib/practice/db';

export type SearchEventKind = 'scout_query' | 'prepare_verify' | 'prep_visit' | 'leak_reveal';

export interface LogSearchEventInput {
  kind: SearchEventKind;
  profileId?: string | null;
  queryText?: string | null;
  targetPlatform?: 'lichess' | 'chess.com' | null;
  targetHandle?: string | null;
  resultCount?: number | null;
  leakFingerprint?: string | null;
  costCredits?: number | null;
  extra?: Record<string, unknown> | null;
}

const SEARCH_SESSION_COOKIE = 'search_session_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let warnedMissingSecret = false;

function hashWithSecret(input: string): string | null {
  const secret = process.env.SEARCH_IP_HASH_SECRET;
  if (!secret) {
    if (!warnedMissingSecret) {
      console.warn(
        '[search-events] SEARCH_IP_HASH_SECRET not set — anon IP hashes will not be recorded',
      );
      warnedMissingSecret = true;
    }
    return null;
  }
  return createHmac('sha256', secret).update(input).digest('base64').slice(0, 22);
}

function pickFirstHop(forwarded: string | null): string | null {
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

function safeDecodeHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function logSearchEvent(input: LogSearchEventInput): Promise<void> {
  try {
    const hdrs = await headers();
    const cookieStore = await cookies();

    const sessionId = uuidOrNull(cookieStore.get(SEARCH_SESSION_COOKIE)?.value);

    const ip = pickFirstHop(hdrs.get('x-forwarded-for')) ?? hdrs.get('x-real-ip') ?? null;
    const ipHash = ip ? hashWithSecret(ip) : null;
    const ipGeoCity = hdrs.get('x-vercel-ip-city') || null;
    const ipGeoCountry = hdrs.get('x-vercel-ip-country') || null;
    const ipGeoRegion = hdrs.get('x-vercel-ip-country-region') || null;

    const ua = hdrs.get('user-agent');
    const userAgentHash = ua ? hashWithSecret(ua) : null;

    const sql = getPracticeDb();
    await sql`
      INSERT INTO search_events (
        kind,
        profile_id,
        search_session_id,
        ip_hash,
        ip_geo_city,
        ip_geo_country,
        ip_geo_region,
        user_agent_hash,
        query_text,
        target_platform,
        target_handle,
        result_count,
        leak_fingerprint,
        cost_credits,
        extra
      )
      VALUES (
        ${input.kind},
        ${uuidOrNull(input.profileId)}::uuid,
        ${sessionId}::uuid,
        ${ipHash},
        ${safeDecodeHeader(ipGeoCity)},
        ${ipGeoCountry},
        ${ipGeoRegion},
        ${userAgentHash},
        ${input.queryText ?? null},
        ${input.targetPlatform ?? null},
        ${input.targetHandle ?? null},
        ${input.resultCount ?? null},
        ${input.leakFingerprint ?? null},
        ${input.costCredits ?? null},
        ${input.extra ? JSON.stringify(input.extra) : null}::jsonb
      )
    `;
  } catch (err) {
    console.error('[search-events] log failed (non-fatal):', err);
  }
}
