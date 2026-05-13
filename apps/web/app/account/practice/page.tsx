import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { PracticePrefsForm } from './prefs-form';

export const metadata = {
  title: 'Practice preferences',
};

export default async function PracticePrefsPage() {
  const user = await requireUser();
  const supabase = await createClient();

  const { data } = await supabase
    .from('user_practice_prefs')
    .select(
      'board_theme, piece_set, sound_enabled, animations_enabled, premoves_enabled, auto_promote_queen, show_legal_moves, show_coordinates',
    )
    .eq('profile_id', user.id)
    .maybeSingle();

  const initial = {
    boardTheme: (data?.board_theme as 'classic' | 'wood' | 'green' | 'blue' | 'gray') ?? 'classic',
    pieceSet: (data?.piece_set as 'cburnett' | 'merida' | 'alpha' | 'staunton') ?? 'cburnett',
    soundEnabled: data?.sound_enabled ?? true,
    animationsEnabled: data?.animations_enabled ?? true,
    premovesEnabled: data?.premoves_enabled ?? true,
    autoPromoteQueen: data?.auto_promote_queen ?? false,
    showLegalMoves: data?.show_legal_moves ?? true,
    showCoordinates: data?.show_coordinates ?? true,
  };

  return (
    <div className="container mx-auto max-w-2xl space-y-8 px-4 py-12">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Account</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">Practice preferences</h1>
        <p className="text-sm text-muted-foreground">
          How the board, pieces, and sounds behave during live games and reviews.
        </p>
        <p className="text-xs text-muted-foreground">
          <Link href="/account" className="hover:underline">
            ← Back to account
          </Link>
        </p>
      </header>

      <PracticePrefsForm initial={initial} />
    </div>
  );
}
