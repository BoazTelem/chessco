import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { brand } from '@chessco/ui';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ChesscoMark } from '@/lib/logo';
import { ReviewBoard } from '@/components/practice/ReviewBoard';

export const metadata = {
  title: 'Practice — review with Stockfish',
};

interface RouteProps {
  params: Promise<{ id: string }>;
}

export default async function PracticeReviewPage({ params }: RouteProps) {
  const { id: matchId } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(matchId)) notFound();

  const user = await requireUser();
  const supabase = await createClient();

  const { data: lg } = await supabase
    .from('live_games')
    .select(
      'pgn, initial_fen, white_user_id, black_user_id, status, result, termination, white:profiles!live_games_white_user_id_fkey(display_name, username), black:profiles!live_games_black_user_id_fkey(display_name, username)',
    )
    .eq('match_id', matchId)
    .maybeSingle();

  if (!lg) notFound();
  if (lg.white_user_id !== user.id && lg.black_user_id !== user.id) notFound();
  if (lg.status === 'live') redirect(`/practice/g/${matchId}`);

  type RawProfile = { display_name: string | null; username: string | null } | null;
  const wp: RawProfile = Array.isArray(lg.white) ? (lg.white[0] ?? null) : (lg.white ?? null);
  const bp: RawProfile = Array.isArray(lg.black) ? (lg.black[0] ?? null) : (lg.black ?? null);

  const whiteName = wp?.display_name ?? wp?.username ?? 'White';
  const blackName = bp?.display_name ?? bp?.username ?? 'Black';

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
            <span>Review</span>
          </div>
          <nav className="text-sm text-muted-foreground">
            {lg.result ?? '—'} {lg.termination ? `· ${lg.termination}` : ''}
          </nav>
        </div>
      </header>
      <main className="container mx-auto max-w-6xl px-4 py-6">
        <ReviewBoard
          pgn={lg.pgn ?? ''}
          initialFen={lg.initial_fen}
          whiteName={whiteName}
          blackName={blackName}
        />
      </main>
    </div>
  );
}
