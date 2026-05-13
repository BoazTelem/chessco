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
    <div className="flex min-h-screen flex-col">
      {/* Minimal floating brand chip — keeps the board immersive but leaves a
          one-click route home if the player needs to bail. */}
      <Link
        href="/"
        aria-label={brand.name}
        className="fixed left-4 top-4 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 text-xs backdrop-blur hover:bg-card"
      >
        <ChesscoMark className="h-3.5 w-3.5 shrink-0" />
        <span className="font-display font-semibold uppercase tracking-[0.25em] text-accent">
          {brand.name}
        </span>
        <span className="text-muted-foreground">· {lg.time_control}</span>
      </Link>
      <main className="container mx-auto max-w-6xl flex-1 px-4 py-12 md:py-16">
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
