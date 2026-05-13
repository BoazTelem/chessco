import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { brand } from '@chessco/ui';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ChesscoMark } from '@/lib/logo';
import { GamePlayer } from '@/components/practice/GamePlayer';
import { signTicket } from '@/lib/practice/ws-ticket';

export const metadata = {
  title: 'Practice — live game',
};

interface RouteProps {
  params: Promise<{ id: string }>;
}

export default async function PracticeGamePage({ params }: RouteProps) {
  const { id: matchId } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(matchId)) notFound();

  const user = await requireUser();
  const supabase = await createClient();

  // RLS gives us the live_game row only if we're a participant.
  const { data: lg } = await supabase
    .from('live_games')
    .select('white_user_id, black_user_id, status, time_control, initial_fen')
    .eq('match_id', matchId)
    .maybeSingle();

  if (!lg) notFound();

  let role: 'white' | 'black';
  if (lg.white_user_id === user.id) role = 'white';
  else if (lg.black_user_id === user.id) role = 'black';
  else notFound();

  // If the game already ended (e.g. reload after end), bounce to review.
  if (lg.status !== 'live') {
    redirect(`/practice/g/${matchId}/review`);
  }

  // Lazy-create user_practice_prefs row by reading; defaults if missing.
  const { data: prefsRow } = await supabase
    .from('user_practice_prefs')
    .select(
      'sound_enabled, premoves_enabled, show_coordinates, show_legal_moves, animations_enabled',
    )
    .eq('profile_id', user.id)
    .maybeSingle();

  const prefs = {
    soundEnabled: prefsRow?.sound_enabled ?? true,
    premovesEnabled: prefsRow?.premoves_enabled ?? true,
    showCoordinates: prefsRow?.show_coordinates ?? true,
    showLegalMoves: prefsRow?.show_legal_moves ?? true,
    animationsEnabled: prefsRow?.animations_enabled ?? true,
  };

  const ticket = signTicket({ matchId, userId: user.id, role });
  const wsBase = process.env.NEXT_PUBLIC_PRACTICE_WS_URL ?? 'ws://localhost:3001';
  const initialWsUrl = `${wsBase}/game/${matchId}?ticket=${encodeURIComponent(ticket)}`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/"
              aria-label={brand.name}
              className="inline-flex items-center gap-2 hover:opacity-80"
            >
              <ChesscoMark className="h-4 w-4 shrink-0" />
              <span className="font-display font-semibold uppercase tracking-[0.3em] text-accent">
                {brand.name}
              </span>
            </Link>
            <span className="text-muted-foreground">/</span>
            <Link href="/practice" className="text-muted-foreground hover:text-foreground">
              Practice
            </Link>
            <span className="text-muted-foreground">/</span>
            <span>Game</span>
          </div>
          <nav className="text-sm text-muted-foreground">{lg.time_control}</nav>
        </div>
      </header>
      <main className="container mx-auto max-w-6xl px-4 py-6">
        <GamePlayer
          matchId={matchId}
          initialWsUrl={initialWsUrl}
          initialRole={role}
          prefs={prefs}
        />
      </main>
    </div>
  );
}
