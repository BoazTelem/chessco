/**
 * GET  /api/practice/prefs — return the caller's preferences (defaults if no row yet).
 * PATCH /api/practice/prefs — upsert any subset of fields.
 *
 * Stores per-user board/sound/piece preferences for the live game and
 * review boards. Authenticated. RLS ensures user only sees/writes their own row.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const Prefs = z.object({
  boardTheme: z.enum(['classic', 'wood', 'green', 'blue', 'gray']).optional(),
  pieceSet: z.enum(['cburnett', 'merida', 'alpha', 'staunton']).optional(),
  soundEnabled: z.boolean().optional(),
  animationsEnabled: z.boolean().optional(),
  premovesEnabled: z.boolean().optional(),
  autoPromoteQueen: z.boolean().optional(),
  showLegalMoves: z.boolean().optional(),
  showCoordinates: z.boolean().optional(),
});

const DEFAULTS = {
  boardTheme: 'classic' as const,
  pieceSet: 'cburnett' as const,
  soundEnabled: true,
  animationsEnabled: true,
  premovesEnabled: true,
  autoPromoteQueen: false,
  showLegalMoves: true,
  showCoordinates: true,
};

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data } = await supabase
    .from('user_practice_prefs')
    .select(
      'board_theme, piece_set, sound_enabled, animations_enabled, premoves_enabled, auto_promote_queen, show_legal_moves, show_coordinates',
    )
    .eq('profile_id', user.id)
    .maybeSingle();

  if (!data) return NextResponse.json(DEFAULTS);
  return NextResponse.json({
    boardTheme: data.board_theme,
    pieceSet: data.piece_set,
    soundEnabled: data.sound_enabled,
    animationsEnabled: data.animations_enabled,
    premovesEnabled: data.premoves_enabled,
    autoPromoteQueen: data.auto_promote_queen,
    showLegalMoves: data.show_legal_moves,
    showCoordinates: data.show_coordinates,
  });
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let patch: z.infer<typeof Prefs>;
  try {
    patch = Prefs.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  // Build the row to upsert. Start from defaults, overlay any prior row,
  // overlay the patch — guarantees a complete row on first PATCH.
  const { data: existing } = await supabase
    .from('user_practice_prefs')
    .select('*')
    .eq('profile_id', user.id)
    .maybeSingle();

  const merged = {
    profile_id: user.id,
    board_theme: patch.boardTheme ?? existing?.board_theme ?? DEFAULTS.boardTheme,
    piece_set: patch.pieceSet ?? existing?.piece_set ?? DEFAULTS.pieceSet,
    sound_enabled: patch.soundEnabled ?? existing?.sound_enabled ?? DEFAULTS.soundEnabled,
    animations_enabled:
      patch.animationsEnabled ?? existing?.animations_enabled ?? DEFAULTS.animationsEnabled,
    premoves_enabled:
      patch.premovesEnabled ?? existing?.premoves_enabled ?? DEFAULTS.premovesEnabled,
    auto_promote_queen:
      patch.autoPromoteQueen ?? existing?.auto_promote_queen ?? DEFAULTS.autoPromoteQueen,
    show_legal_moves: patch.showLegalMoves ?? existing?.show_legal_moves ?? DEFAULTS.showLegalMoves,
    show_coordinates:
      patch.showCoordinates ?? existing?.show_coordinates ?? DEFAULTS.showCoordinates,
  };

  const { error } = await supabase
    .from('user_practice_prefs')
    .upsert(merged, { onConflict: 'profile_id' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
