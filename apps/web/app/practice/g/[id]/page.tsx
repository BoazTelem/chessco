import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { brand } from '@chessco/ui';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { ChesscoMark } from '@/lib/logo';
import { GamePlayer } from '@/components/practice/GamePlayer';
import type { PlayerInfo } from '@/components/practice/PlayerCard';
import { signTicket } from '@/lib/practice/ws-ticket';

export const metadata = {
  title: 'Practice — live game',
};

interface RouteProps {
  params: Promise<{ id: string }>;
}

interface PlayerRow {
  id: string;
  username: string | null;
  display_name: string | null;
  country: string | null;
  chess_title: string | null;
  profile_visibility: 'public' | 'private' | 'coach_public_player_private' | null;
  skill_rating: number | null;
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

  // Player cards: name, title, country flag, rating. Anonymity propagates
  // from the originating challenge — same rule the lobby card already uses.
  // skill_rating is numeric in Postgres; ROUND() it server-side so the
  // JSON driver delivers a clean integer rather than a string.
  const sql = getPracticeDb();
  const playerRows = (await sql`
    SELECT
      p.id,
      p.username,
      p.display_name,
      p.country,
      p.chess_title,
      p.profile_visibility,
      ROUND(r.skill_rating)::int AS skill_rating
    FROM profiles p
    LEFT JOIN ratings r ON r.profile_id = p.id
    WHERE p.id IN (${lg.white_user_id}, ${lg.black_user_id})
  `) as PlayerRow[];

  const anonRows = (await sql`
    SELECT c.anonymous
    FROM matches m
    JOIN challenges c ON c.id = m.challenge_id
    WHERE m.id = ${matchId}
    LIMIT 1
  `) as Array<{ anonymous: boolean }>;
  const matchAnonymous = anonRows[0]?.anonymous ?? false;

  const byId = new Map(playerRows.map((p) => [p.id, p]));
  const whitePlayer = buildPlayerInfo(byId.get(lg.white_user_id), lg.white_user_id, matchAnonymous);
  const blackPlayer = buildPlayerInfo(byId.get(lg.black_user_id), lg.black_user_id, matchAnonymous);

  const ticket = signTicket({ matchId, userId: user.id, role });
  const wsBase = process.env.NEXT_PUBLIC_PRACTICE_WS_URL || 'ws://localhost:3001';
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
      <main className="flex-1 px-2 pt-14 pb-4 md:px-4">
        <GamePlayer
          matchId={matchId}
          initialWsUrl={initialWsUrl}
          initialRole={role}
          initialFen={lg.initial_fen}
          prefs={prefs}
          whitePlayer={whitePlayer}
          blackPlayer={blackPlayer}
        />
      </main>
    </div>
  );
}

function buildPlayerInfo(
  row: PlayerRow | undefined,
  userId: string,
  matchAnonymous: boolean,
): PlayerInfo {
  if (matchAnonymous || !row) {
    return {
      userId,
      displayName: 'Anonymous',
      profileHref: null,
      countryIso2: null,
      chessTitle: null,
      rating: null,
    };
  }
  const displayName = row.display_name ?? row.username ?? 'A player';
  const profileHref =
    row.profile_visibility === 'public' && row.username ? `/u/${row.username}` : null;
  return {
    userId,
    displayName,
    profileHref,
    countryIso2: row.country,
    chessTitle: row.chess_title,
    rating: row.skill_rating,
  };
}
