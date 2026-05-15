import Link from 'next/link';
import { unstable_cache } from 'next/cache';
import { brand } from '@chessco/ui';
import { getPracticeDb } from '@/lib/practice/db';
import { CountryBadge, TitleBadge } from '../scout/result-card';

export const metadata = {
  title: 'Hall of Fame',
  description: `Top players who help others practice on ${brand.name}, ranked by credits earned.`,
};

// Rendered on demand so the build doesn't need DB access. The leaderboard
// query itself is cached at the data layer (5-minute TTL) — credits earned
// shifts slowly relative to that window, which keeps this cheap.
export const dynamic = 'force-dynamic';

type LeaderRow = {
  profile_id: string;
  username: string | null;
  display_name: string | null;
  country: string | null;
  chess_title: string | null;
  avatar_url: string | null;
  credits_earned: number;
  games_helped: number;
};

const LIMIT = 50;

// Top earners by practice_reward credits. The query joins through profiles
// and excludes private/deleted accounts so the leaderboard is fully public.
// SUM/COUNT aggregates well within ~50 rows; if practice_reward volume
// grows enough that this is slow, the next step is a materialized view.
const getLeaders = unstable_cache(
  async (): Promise<LeaderRow[]> => {
    const sql = getPracticeDb();
    const rows = (await sql`
      SELECT
        p.id          AS profile_id,
        p.username,
        p.display_name,
        p.country,
        p.chess_title,
        p.avatar_url,
        COALESCE(SUM(cle.amount), 0)::int AS credits_earned,
        COUNT(*)::int                      AS games_helped
      FROM credit_ledger_entries cle
      JOIN profiles p ON p.id = cle.profile_id
      WHERE cle.category = 'practice_reward'
        AND cle.direction = 'C'
        AND p.profile_visibility = 'public'
        AND p.deleted_at IS NULL
      GROUP BY p.id, p.username, p.display_name, p.country, p.chess_title, p.avatar_url
      ORDER BY credits_earned DESC, games_helped DESC
      LIMIT ${LIMIT}
    `) as LeaderRow[];
    return rows;
  },
  ['hall-of-fame-leaders'],
  { revalidate: 300, tags: ['hall-of-fame'] },
);

export default async function HallOfFamePage() {
  const rows = await getLeaders();

  return (
    <div className="min-h-screen">
      <main className="container mx-auto max-w-3xl px-4 py-12">
        <header className="space-y-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Community</p>
          <h1 className="font-display text-4xl font-bold tracking-tight md:text-5xl">
            Hall of Fame
          </h1>
          <p className="mx-auto max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
            The players who help others practice the most. Every paid practice game you accept and
            finish earns you 1 credit. Show up, play strong, climb the board.
          </p>
        </header>

        {rows.length === 0 ? (
          <EmptyState />
        ) : (
          <section className="mt-10 overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-card text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">#</th>
                  <th className="px-4 py-3 text-left font-semibold">Player</th>
                  <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">
                    Games helped
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">Credits</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <LeaderRowView key={row.profile_id} row={row} rank={i + 1} />
                ))}
              </tbody>
            </table>
          </section>
        )}

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Updated every five minutes · Private profiles are not shown
        </p>

        <section className="mt-12 rounded-xl border border-accent/30 bg-accent/5 p-6 text-center">
          <p className="text-sm text-foreground">
            Want to be on the board? Accept paid practice challenges in the lobby.
          </p>
          <Link
            href="/practice"
            className="mt-4 inline-block rounded-md bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
          >
            Open the practice lobby →
          </Link>
        </section>
      </main>
    </div>
  );
}

function LeaderRowView({ row, rank }: { row: LeaderRow; rank: number }) {
  const name = row.display_name ?? row.username ?? 'Anonymous';
  const initials = initialsFor(row.display_name ?? row.username ?? '?');
  const linkable = !!row.username;
  const profileHref = linkable ? `/u/${row.username}` : null;

  const NameLine = (
    <span className="font-medium text-foreground">
      {name}
      {row.username && <span className="ml-2 text-xs text-muted-foreground">@{row.username}</span>}
    </span>
  );

  return (
    <tr className="border-b border-border/40 last:border-0 hover:bg-background/40">
      <td className="px-4 py-3 font-mono text-sm tabular-nums">
        <RankBadge rank={rank} />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar src={row.avatar_url} initials={initials} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {profileHref ? (
                <Link href={profileHref} className="hover:text-accent hover:underline">
                  {NameLine}
                </Link>
              ) : (
                NameLine
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              {row.chess_title && <TitleBadge title={row.chess_title} />}
              {row.country && <CountryBadge code={row.country} />}
            </div>
          </div>
        </div>
      </td>
      <td className="hidden px-4 py-3 text-right font-mono text-sm text-muted-foreground tabular-nums sm:table-cell">
        {row.games_helped.toLocaleString()}
      </td>
      <td className="px-4 py-3 text-right font-mono text-base font-semibold text-accent tabular-nums">
        {row.credits_earned.toLocaleString()}
      </td>
    </tr>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-base">🥇</span>;
  if (rank === 2) return <span className="text-base">🥈</span>;
  if (rank === 3) return <span className="text-base">🥉</span>;
  return <span className="text-muted-foreground">{rank}</span>;
}

function Avatar({ src, initials }: { src: string | null; initials: string }) {
  if (src) {
    // Profile avatars are user-uploaded; <img> over next/image avoids the
    // remote-pattern allowlist hassle for storage URLs.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-border"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted/40 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground ring-1 ring-border"
    >
      {initials}
    </span>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function EmptyState() {
  return (
    <section className="mt-10 rounded-xl border border-border bg-card p-10 text-center">
      <p className="font-display text-lg font-semibold">No champions yet</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Once players start completing paid practice games, the top earners show up here.
      </p>
      <Link
        href="/practice"
        className="mt-5 inline-block rounded-md bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
      >
        Be the first
      </Link>
    </section>
  );
}
