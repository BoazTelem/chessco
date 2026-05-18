import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { countryFlag, countryName } from '@/lib/scout/countries';
import { SampleGameForm } from '../../../scout/sample-game-form';
import { IdentifyAdHocButton } from './identify-adhoc-button';

export const metadata = { title: 'Custom player' };

interface AdHocPlayer {
  id: string;
  name: string;
  country: string | null;
  created_by: string;
  created_at: string;
}

export default async function AdHocPlayerPage({
  params,
}: {
  params: Promise<{ adhoc_id: string }>;
}) {
  const { adhoc_id } = await params;
  const supabase = await createClient();

  const { data: player } = (await supabase
    .from('ad_hoc_players')
    .select('id, name, country, created_by, created_at')
    .eq('id', adhoc_id)
    .maybeSingle()) as { data: AdHocPlayer | null };

  if (!player) notFound();

  const flag = countryFlag(player.country);
  const countryLabel = countryName(player.country);

  return (
    <div className="min-h-screen">
      <main className="container mx-auto max-w-4xl px-4 py-10">
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
              Custom entry
            </span>
            {player.country && (
              <span className="rounded-md border border-border bg-card px-2 py-0.5 text-xs">
                {flag} {countryLabel}
              </span>
            )}
          </div>
          <h1 className="font-display text-4xl font-bold tracking-tight">{player.name}</h1>
          <p className="text-sm text-muted-foreground">
            Tracked entry · created {new Date(player.created_at).toLocaleDateString()}
            {player.country && (
              <>
                {' · '}
                {countryLabel}
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            No FIDE / ICF / USCF entry yet. Use AI matching below to find their accounts. Confirmed
            handles persist for future searches.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Find their online accounts
          </h2>
          <div className="mt-3 space-y-5 rounded-lg border border-border bg-card p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Quick name search
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Match {player.name} to chess.com handles via fuzzy name search + country on our
                online corpus. Fast, but limited for amateur players.
              </p>
              <div className="mt-3">
                <IdentifyAdHocButton adHocPlayerId={player.id} />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                or
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                AI matching by sample game
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Have games of {player.name}? Paste PGNs for repertoire matching by play pattern. It
                works even when their handle looks nothing like their name; game-count guidance
                comes from /benchmarks.
              </p>
              <div className="mt-3">
                <SampleGameForm adHocPlayerId={player.id} subjectLabel={player.name} />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
