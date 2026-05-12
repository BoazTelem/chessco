/**
 * Lazy handle probe — invoked from Stage 2 when the cached corpus may
 * not have the target. Synthesizes likely handles from the FIDE name
 * (handle-synth.ts), probes chess.com /pub/player/{u} in parallel and
 * Lichess /api/users in a single batched POST, upserts hits into
 * platform_players so the next user hits the cache.
 *
 * Bounded fan-out (16 chess.com probes max) and short per-probe timeouts
 * (1.5s) keep web latency in the 1-2s budget. Failures are silent — if
 * chess.com 429s, we just return whatever Lichess gave us.
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { CHESSCOM_API_BASE, type ChesscomPlayer, type ChesscomStats } from '@/lib/chesscom';
import { LICHESS_API_BASE, type LichessAccount } from '@/lib/lichess';
import { synthesizeHandleCandidates } from './handle-synth';

const CHESSCOM_USER_AGENT = 'chessco/0.1 (+https://chessco.org)';
const CHESSCOM_PROBE_TIMEOUT_MS = 1500;
const LICHESS_PROBE_TIMEOUT_MS = 2500;

export interface ProbeHit {
  platform: 'lichess' | 'chess.com';
  handle: string;
  handle_normalized: string;
  country: string | null;
  title: string | null;
  claimed_name: string | null;
  rating_bullet: number | null;
  rating_blitz: number | null;
  rating_rapid: number | null;
  rating_classical: number | null;
}

/** Strip the trailing ISO code off a chess.com country URL. */
function isoFromCountryUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /\/country\/([A-Z]{2,3})$/.exec(url);
  return m?.[1] ?? null;
}

/** GET a chess.com URL with timeout; returns null on 404 or any error. */
async function fetchChesscomJson<T>(path: string, signal: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(`${CHESSCOM_API_BASE}${path}`, {
      headers: { 'User-Agent': CHESSCOM_USER_AGENT, Accept: 'application/json' },
      signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function probeChesscomOne(handle: string): Promise<ProbeHit | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CHESSCOM_PROBE_TIMEOUT_MS);
  try {
    const player = await fetchChesscomJson<ChesscomPlayer>(`/player/${handle}`, ac.signal);
    if (!player) return null;
    // Stats are best-effort; missing stats shouldn't drop the hit.
    const stats = await fetchChesscomJson<ChesscomStats>(`/player/${handle}/stats`, ac.signal);
    return {
      platform: 'chess.com',
      handle: player.username,
      handle_normalized: player.username.toLowerCase(),
      country: isoFromCountryUrl(player.country),
      title: player.title ?? null,
      claimed_name: player.name ?? null,
      rating_bullet: stats?.chess_bullet?.last?.rating ?? null,
      rating_blitz: stats?.chess_blitz?.last?.rating ?? null,
      rating_rapid: stats?.chess_rapid?.last?.rating ?? null,
      rating_classical: stats?.chess_daily?.last?.rating ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeChesscom(handles: string[]): Promise<ProbeHit[]> {
  const settled = await Promise.allSettled(handles.map((h) => probeChesscomOne(h)));
  return settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((x): x is ProbeHit => x !== null);
}

interface LichessProfileBlock {
  country?: string;
  realName?: string;
}
interface LichessUserExtended extends LichessAccount {
  title?: string;
  profile?: LichessProfileBlock;
}

function lichessRatingFromPerf(perf?: { rating?: number; prov?: boolean }): number | null {
  if (!perf || perf.rating === undefined) return null;
  if (perf.prov) return null;
  return perf.rating;
}

/**
 * Lichess `POST /api/users` takes a plain-text comma-separated list of up
 * to 300 IDs and returns JSON for those that exist. No auth needed. One
 * request handles the full synthesis batch.
 */
async function probeLichess(handles: string[]): Promise<ProbeHit[]> {
  if (handles.length === 0) return [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LICHESS_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${LICHESS_API_BASE}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Accept: 'application/json' },
      body: handles.join(','),
      signal: ac.signal,
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const users = (await res.json()) as LichessUserExtended[];
    return users.map((u) => ({
      platform: 'lichess' as const,
      handle: u.username,
      handle_normalized: u.username.toLowerCase(),
      country: u.profile?.country ?? null,
      title: u.title ?? null,
      claimed_name: u.profile?.realName ?? null,
      rating_bullet: lichessRatingFromPerf(u.perfs?.bullet),
      rating_blitz: lichessRatingFromPerf(u.perfs?.blitz),
      rating_rapid: lichessRatingFromPerf(u.perfs?.rapid),
      rating_classical: lichessRatingFromPerf(u.perfs?.classical),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function normalizeClaimedName(s: string | null): string | null {
  if (!s) return null;
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}

/**
 * Upsert probe hits so the next request for this name skips the probe.
 * `pulled_via='lazy'` is the marker for "discovered via name probe at
 * identify time" — distinct from country/titled bulk pulls.
 */
async function upsertProbeHits(
  supabase: ReturnType<typeof createAdminClient>,
  hits: ProbeHit[],
): Promise<void> {
  if (hits.length === 0) return;
  const rows = hits.map((h) => ({
    platform: h.platform,
    handle: h.handle,
    handle_normalized: h.handle_normalized,
    country: h.country,
    title: h.title,
    claimed_name: h.claimed_name,
    claimed_name_normalized: normalizeClaimedName(h.claimed_name),
    rating_bullet: h.rating_bullet,
    rating_blitz: h.rating_blitz,
    rating_rapid: h.rating_rapid,
    rating_classical: h.rating_classical,
    pulled_via: 'lazy',
    last_seen_at: new Date().toISOString(),
  }));
  // Best-effort — failures here shouldn't break the user's identify response.
  await supabase
    .from('platform_players')
    .upsert(rows, { onConflict: 'platform,handle', ignoreDuplicates: false });
}

export interface LazyProbeInput {
  name: string;
  birthYear?: number | null;
}

/**
 * Run the full lazy probe: synthesize candidates, fan out to both platforms
 * in parallel, upsert hits, return them. Caller merges with cached results.
 */
export async function runLazyProbe(input: LazyProbeInput): Promise<ProbeHit[]> {
  const candidates = synthesizeHandleCandidates(input.name, input.birthYear ?? null);
  if (candidates.length === 0) return [];

  const [chesscomHits, lichessHits] = await Promise.all([
    probeChesscom(candidates),
    probeLichess(candidates),
  ]);
  const allHits = [...chesscomHits, ...lichessHits];

  // Fire upsert without blocking the response: caller awaits the hits we
  // return, the upsert can finish during request teardown. But on Vercel
  // serverless we can't reliably outlive the response, so do await.
  const supabase = createAdminClient();
  await upsertProbeHits(supabase, allHits);

  return allHits;
}
