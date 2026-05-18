import Link from 'next/link';
import { brand } from '@chessco/ui';

export const metadata = {
  title: 'Pricing',
  description: `${brand.name} subscription tiers. Pay monthly, get credits, never pay per game.`,
};

type Tier = {
  code: 'free' | 'club' | 'master' | 'gm' | 'sgm';
  name: string;
  priceUsd: number;
  tagline: string;
  signupCredits: number;
  monthlyCredits: number;
  leaksPerOpponent: string;
  extraLeakCost: string;
  badge?: string;
  highlight?: boolean;
};

const TIERS: Tier[] = [
  {
    code: 'free',
    name: 'Free',
    priceUsd: 0,
    tagline: 'Try every core feature, no card needed.',
    signupCredits: 10,
    monthlyCredits: 0,
    leaksPerOpponent: '1',
    extraLeakCost: '5 credits',
  },
  {
    code: 'club',
    name: 'Club Player',
    priceUsd: 5,
    tagline: 'For players who use Chessco every week.',
    signupCredits: 10,
    monthlyCredits: 20,
    leaksPerOpponent: '5',
    extraLeakCost: '4 credits',
    badge: 'Most popular',
    highlight: true,
  },
  {
    code: 'master',
    name: 'Master',
    priceUsd: 29,
    tagline: 'Deep prep, full history, full analytics.',
    signupCredits: 10,
    monthlyCredits: 100,
    leaksPerOpponent: '10',
    extraLeakCost: '2 credits',
  },
  {
    code: 'gm',
    name: 'Grandmaster',
    priceUsd: 99,
    tagline: 'Serious tournament prep with priority surfaces.',
    signupCredits: 10,
    monthlyCredits: 400,
    leaksPerOpponent: '20',
    extraLeakCost: '1 credit',
  },
  {
    code: 'sgm',
    name: 'Super Grandmaster',
    priceUsd: 999,
    tagline: 'The all-in tier. Status, signal, and 10 Seconds.',
    signupCredits: 10,
    monthlyCredits: 4000,
    // 'All' instead of 'Unlimited' so the dd doesn't push the dt
    // "Weakness reveals / opponent" into a third wrapped line and break
    // row alignment with the other tier cards. The comparison table
    // below uses the longer 'Unlimited' since it has the width for it.
    leaksPerOpponent: 'All',
    extraLeakCost: 'Free',
  },
];

type FeatureRow = {
  label: string;
  free: string | boolean;
  club: string | boolean;
  master: string | boolean;
  gm: string | boolean;
  sgm: string | boolean;
};

const FEATURE_ROWS: FeatureRow[] = [
  { label: 'Scout', free: true, club: true, master: true, gm: true, sgm: true },
  { label: 'Match', free: true, club: true, master: true, gm: true, sgm: true },
  { label: 'Prepare', free: true, club: true, master: true, gm: true, sgm: true },
  {
    label: 'Find opponent weaknesses (per opponent)',
    free: '1',
    club: '5',
    master: '10',
    gm: '20',
    sgm: 'Unlimited',
  },
  {
    label: 'Extra weakness reveal',
    free: '5 credits',
    club: '4 credits',
    master: '2 credits',
    gm: '1 credit',
    sgm: 'Free',
  },
  { label: 'Free practice', free: true, club: true, master: true, gm: true, sgm: true },
  {
    label: 'Earn credits for practice',
    free: true,
    club: true,
    master: true,
    gm: true,
    sgm: true,
  },
  {
    label: 'Top up (buy credits)',
    free: true,
    club: true,
    master: true,
    gm: true,
    sgm: true,
  },
  {
    label: 'Credits per friend you refer',
    free: '20',
    club: '20',
    master: '20',
    gm: '20',
    sgm: '20',
  },
  { label: 'Friends list', free: false, club: true, master: true, gm: true, sgm: true },
  { label: 'Training history', free: false, club: false, master: true, gm: true, sgm: true },
  {
    label: 'Recommended practice partners',
    free: false,
    club: false,
    master: true,
    gm: true,
    sgm: true,
  },
  { label: 'Analytics dashboard', free: false, club: false, master: true, gm: true, sgm: true },
  { label: 'Who searched me', free: false, club: false, master: false, gm: true, sgm: true },
  {
    label: 'Seconds (spectator seats)',
    free: false,
    club: false,
    master: false,
    gm: false,
    sgm: '10 seats',
  },
];

function CheckMark() {
  return (
    <span aria-label="included" className="text-accent">
      ✓
    </span>
  );
}

function CrossMark() {
  return (
    <span aria-label="not included" className="text-muted-foreground/40">
      -
    </span>
  );
}

function Cell({ value }: { value: string | boolean }) {
  if (value === true) return <CheckMark />;
  if (value === false) return <CrossMark />;
  return <span className="text-foreground">{value}</span>;
}

function TierCard({ tier }: { tier: Tier }) {
  const ringClass = tier.highlight
    ? 'border-accent ring-1 ring-accent/40'
    : 'border-border hover:border-accent/40';
  return (
    <div
      className={`relative flex h-full flex-col rounded-xl border bg-card p-5 transition ${ringClass}`}
    >
      {tier.badge && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-accent/40 bg-accent px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-foreground">
          {tier.badge}
        </span>
      )}
      <div className="space-y-1">
        {/* min-h reserves 2 lines so "Super Grand Master" doesn't push its
            price row down relative to single-line tier names. */}
        <p className="min-h-[2.5rem] font-display text-sm font-semibold uppercase tracking-[0.3em] text-accent">
          {tier.name}
        </p>
        <p className="font-display text-3xl font-bold tracking-tight">
          ${tier.priceUsd}
          <span className="ml-1 text-sm font-normal text-muted-foreground">
            {tier.priceUsd === 0 ? 'forever' : '/ month'}
          </span>
        </p>
        {/* Same idea: fixes the start of the dl block across cards. */}
        <p className="min-h-[3rem] pt-1 text-xs leading-relaxed text-muted-foreground">
          {tier.tagline}
        </p>
      </div>

      <dl className="mt-5 space-y-2.5 text-xs">
        <div className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-2">
          <dt className="text-muted-foreground">Signup credits</dt>
          <dd className="font-mono text-foreground">{tier.signupCredits}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-2">
          <dt className="text-muted-foreground">Monthly credits</dt>
          <dd className="font-mono text-foreground">
            {tier.monthlyCredits === 0 ? '0' : tier.monthlyCredits.toLocaleString()}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-2">
          <dt className="text-muted-foreground">Weakness reveals / opponent</dt>
          <dd className="font-mono text-foreground">{tier.leaksPerOpponent}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">Extra reveal</dt>
          <dd className="font-mono text-foreground">{tier.extraLeakCost}</dd>
        </div>
      </dl>

      <div className="mt-auto pt-5">
        <button
          type="button"
          disabled
          className={`w-full rounded-md px-3 py-2 text-xs font-semibold ${
            tier.highlight
              ? 'bg-accent text-accent-foreground opacity-60'
              : 'border border-border bg-background text-muted-foreground opacity-70'
          }`}
        >
          {tier.priceUsd === 0 ? 'Current plan' : 'Coming soon'}
        </button>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <div className="min-h-screen">
      <main className="container mx-auto max-w-6xl px-4 py-12">
        <header className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Pricing</p>
          <h1 className="mt-3 font-display text-4xl font-bold tracking-tight md:text-5xl">
            Start free. Scale when it&apos;s worth it.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground md:text-base">
            Every plan comes with credits. Spend them on prep reveals and paid practice. Earn more
            by helping others practice. Credits never become cash; they keep you on the platform.
          </p>
        </header>

        <section className="mt-8 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          Real-money subscription billing is paused while we finalize our payment partner. Credit
          tiers and the free plan are live now; paid-tier checkout opens once provider integration
          lands.
        </section>

        <section className="mt-8 grid gap-5 md:grid-cols-3 lg:grid-cols-5">
          {TIERS.map((t) => (
            <TierCard key={t.code} tier={t} />
          ))}
        </section>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Monthly subscription credits expire at the end of each billing cycle. Signup, referral,
          and practice-reward credits do not expire. Referral credits are capped at 100 lifetime (5
          friends) per account.
        </p>

        <section className="mt-16">
          <h2 className="font-display text-2xl font-bold tracking-tight">Feature comparison</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything below resets monthly on subscription credits unless otherwise noted.
          </p>
          <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-border bg-card text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Feature</th>
                  {TIERS.map((t) => (
                    <th key={t.code} className="px-4 py-3 text-center font-semibold">
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FEATURE_ROWS.map((row, i) => (
                  <tr key={row.label} className={i % 2 === 0 ? 'bg-background/30' : ''}>
                    <td className="px-4 py-3 text-left text-foreground">{row.label}</td>
                    <td className="px-4 py-3 text-center">
                      <Cell value={row.free} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Cell value={row.club} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Cell value={row.master} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Cell value={row.gm} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Cell value={row.sgm} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-16 grid gap-6 rounded-xl border border-border bg-card p-6 md:grid-cols-3">
          <div>
            <p className="font-display text-sm font-semibold uppercase tracking-[0.3em] text-accent">
              Credits
            </p>
            <h3 className="mt-2 font-display text-lg font-semibold">How they work</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Credits are an internal balance. You spend them to publish paid practice or reveal
              extra opponent weaknesses. You earn them by helping others practice, by inviting
              friends, and by linking your chess.com or Lichess account.
            </p>
          </div>
          <div>
            <p className="font-display text-sm font-semibold uppercase tracking-[0.3em] text-accent">
              Practice
            </p>
            <h3 className="mt-2 font-display text-lg font-semibold">Always free to play</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Free practice is on every tier. You only spend credits when you publish a
              <em> paid </em>
              challenge: 1 credit per game requested, and the player who accepts earns 1 credit per
              game they finish.
            </p>
          </div>
          <div>
            <p className="font-display text-sm font-semibold uppercase tracking-[0.3em] text-accent">
              Community
            </p>
            <h3 className="mt-2 font-display text-lg font-semibold">Make the Hall of Fame</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              The players who help others practice the most show up on the{' '}
              <Link href="/hall-of-fame" className="text-foreground underline hover:text-accent">
                Hall of Fame
              </Link>
              . Accept paid challenges, finish games, climb the board.
            </p>
          </div>
        </section>

        <section className="mt-12 rounded-xl border border-accent/30 bg-accent/5 p-6 text-center">
          <p className="text-sm text-foreground">
            Subscriptions and paid checkout are not live yet. Today every tier is{' '}
            <span className="font-semibold">free</span>, every feature shown above is available, and
            the 10 signup credits land in your wallet when you verify your email.
          </p>
          <Link
            href="/signup"
            className="mt-4 inline-block rounded-md bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
          >
            Start with the free tier
          </Link>
        </section>
      </main>
    </div>
  );
}
