import Link from 'next/link';
import { countryFlag } from '@/lib/scout/countries';
import type { SearchResult } from './types';

export function ResultCard({ result }: { result: SearchResult }) {
  const ratings: Array<[string, number | null]> = [
    ['Std', result.rating_standard],
    ['Rapid', result.rating_rapid],
    ['Blitz', result.rating_blitz],
  ];

  return (
    <Link
      href={`/p/${result.id}`}
      className="block rounded-lg border border-border bg-card p-4 transition hover:border-accent/40 hover:bg-card/80"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FederationBadge code={result.federation_id} />
            {result.title && <TitleBadge title={result.title} />}
            {result.country && <CountryBadge code={result.country} />}
          </div>
          <p className="mt-2 truncate text-base font-medium text-foreground">{result.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {result.federation_id} ID {result.federation_player_id}
            {result.birth_year && <> · born {result.birth_year}</>}
          </p>
        </div>

        <dl className="flex shrink-0 items-center gap-3 text-right">
          {ratings.map(([label, r]) => (
            <div key={label} className="min-w-[3rem]">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </dt>
              <dd className="text-base font-semibold tabular-nums">{r ?? '-'}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Link>
  );
}

export function FederationBadge({ code }: { code: string }) {
  return (
    <span className="rounded-md bg-muted/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {code}
    </span>
  );
}

export function TitleBadge({ title }: { title: string }) {
  const color =
    title === 'GM' || title === 'WGM'
      ? 'bg-accent/15 text-accent border-accent/30'
      : title === 'IM' || title === 'WIM'
        ? 'bg-accent/10 text-accent border-accent/20'
        : 'bg-muted/40 text-muted-foreground border-border';

  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${color}`}
    >
      {title}
    </span>
  );
}

export function CountryBadge({ code }: { code: string }) {
  const flag = countryFlag(code);
  return (
    <span className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {flag ? `${flag} ` : ''}
      {code}
    </span>
  );
}

/**
 * Result row for an online-platform handle hit (chess.com today, Lichess
 * later). External link: clicking the handle opens the player's profile
 * on the platform: that's where users will recognize whether it's their
 * target. Internal "Track this person" CTA wraps the row for those who
 * want to record the find back into Scout.
 */
export interface HandleResult {
  id: string;
  platform: 'lichess' | 'chess.com';
  handle: string;
  claimed_name: string | null;
  country: string | null;
  title: string | null;
  rating_blitz: number | null;
  rating_rapid: number | null;
  rating_classical: number | null;
  sim: number;
  matched_field: 'claimed_name' | 'handle';
}

/**
 * "Community-verified" result: an ad_hoc_players row that the
 * promote-ad-hoc nightly worker has flipped to promotion_status='promoted'.
 *
 * Surfaces in /scout when ≥2 distinct signed-in users have confirmed the
 * same (platform, handle) for the same name. The card links to the
 * canonical /p/adhoc/{id} profile so future scout queries inherit the
 * accumulated knowledge, even though FIDE doesn't have the player.
 */
export interface AdHocResult {
  id: string;
  name: string;
  country: string | null;
  rating_estimate: number | null;
  rating_band_low: number | null;
  rating_band_high: number | null;
  title: string | null;
  confirmed_match_count: number;
  last_confirmed_at: string | null;
  sim: number;
  top_platform: 'lichess' | 'chess.com' | null;
  top_handle: string | null;
  top_handle_confirmer_count: number | null;
}

export function AdHocResultCard({ result }: { result: AdHocResult }) {
  const ratingLabel =
    result.rating_estimate != null
      ? result.rating_band_low != null && result.rating_band_high != null
        ? `${result.rating_estimate} (±${Math.round((result.rating_band_high - result.rating_band_low) / 2)})`
        : `${result.rating_estimate}`
      : null;
  return (
    <Link
      href={`/p/adhoc/${result.id}`}
      className="block rounded-lg border border-accent/30 bg-accent/5 p-4 transition hover:border-accent/60 hover:bg-accent/10"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-accent/40 bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
              Community-verified
            </span>
            {result.title && <TitleBadge title={result.title} />}
            {result.country && <CountryBadge code={result.country} />}
          </div>
          <p className="mt-2 truncate text-base font-medium text-foreground">{result.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {result.top_platform && result.top_handle ? (
              <>
                {result.top_platform} · <span className="font-mono">{result.top_handle}</span> ·{' '}
                confirmed by {result.confirmed_match_count}{' '}
                {result.confirmed_match_count === 1 ? 'user' : 'users'}
              </>
            ) : (
              <>tracked by the community · no canonical handle yet</>
            )}
          </p>
        </div>
        {ratingLabel && (
          <dl className="flex shrink-0 items-center gap-3 text-right">
            <div className="min-w-[3rem]">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Est.</dt>
              <dd className="text-base font-semibold tabular-nums">{ratingLabel}</dd>
            </div>
          </dl>
        )}
      </div>
    </Link>
  );
}

export function HandleResultCard({ result }: { result: HandleResult }) {
  const url =
    result.platform === 'lichess'
      ? `https://lichess.org/@/${result.handle}`
      : `https://www.chess.com/member/${result.handle}`;
  const ratings: Array<[string, number | null]> = [
    ['Blitz', result.rating_blitz],
    ['Rapid', result.rating_rapid],
    ['Daily', result.rating_classical],
  ];
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="block rounded-lg border border-border bg-card p-4 transition hover:border-accent/40 hover:bg-card/80"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-muted/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {result.platform}
            </span>
            {result.title && <TitleBadge title={result.title} />}
            {result.country && <CountryBadge code={result.country} />}
          </div>
          <p className="mt-2 truncate text-base font-medium text-foreground">
            {result.handle}
            {result.claimed_name && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                - {result.claimed_name}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            matched on {result.matched_field === 'claimed_name' ? 'real name' : 'handle'} · opens on{' '}
            {result.platform} ↗
          </p>
        </div>

        <dl className="flex shrink-0 items-center gap-3 text-right">
          {ratings.map(([label, r]) => (
            <div key={label} className="min-w-[3rem]">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </dt>
              <dd className="text-base font-semibold tabular-nums">{r ?? '-'}</dd>
            </div>
          ))}
        </dl>
      </div>
    </a>
  );
}
