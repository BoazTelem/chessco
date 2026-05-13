/**
 * POST /api/practice/challenges — create a Practice challenge (position +
 * time control + fee). Authenticated. Reserves the creator's deposit by
 * moving available_cents → pending_cents on their wallet.
 *
 * Body: see PracticeChallengeInput below.
 * Returns: { id } on success.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { validateFen } from '@/lib/practice/fen';
import { detectOpening } from '@/lib/practice/openings';

const TIME_CONTROL_RE = /^\d+\+\d+$/;
const TIME_CLASS = ['bullet', 'blitz', 'rapid', 'classical'] as const;

const Input = z.object({
  fen: z.string().min(10).max(120),
  pgnPrefix: z.string().max(8000).optional().nullable(),
  creatorColor: z.enum(['w', 'b']).nullable(),
  timeControl: z.string().regex(TIME_CONTROL_RE, 'time_control must look like "5+0"'),
  timeClass: z.enum(TIME_CLASS),
  feeCents: z.number().int().min(0).max(50_000), // $0 (free) .. $500
  gamesRequested: z.number().int().min(1).max(5),
  ratingMin: z.number().int().min(0).max(3500).nullable(),
  ratingMax: z.number().int().min(0).max(3500).nullable(),
  notes: z.string().max(500).optional().nullable(),
  anonymous: z.boolean().optional(),
});

export type PracticeChallengeInput = z.infer<typeof Input>;

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let parsed: PracticeChallengeInput;
  try {
    const body = await req.json();
    parsed = Input.parse(body);
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (
    parsed.ratingMin !== null &&
    parsed.ratingMax !== null &&
    parsed.ratingMin > parsed.ratingMax
  ) {
    return NextResponse.json({ error: 'rating_min must be ≤ rating_max' }, { status: 400 });
  }

  const fenCheck = validateFen(parsed.fen);
  if (!fenCheck.ok) {
    return NextResponse.json({ error: `position invalid: ${fenCheck.reason}` }, { status: 400 });
  }

  // The board is the source of truth for the opening — derive name + ECO from
  // the FEN against the bundled book. Most user-published positions aren't
  // book lines and return null, which the lobby renders as no opening label.
  const detected = detectOpening(fenCheck.fen);

  const totalCents = parsed.feeCents * parsed.gamesRequested;
  const sql = getPracticeDb();

  // Snapshot the creator's best-known rating at publish time, so the lobby
  // can render a rating next to "Anonymous" (or alongside the name) without
  // joining external_accounts at query time. Best rapid > blitz > classical
  // across verified online accounts; falls back to ratings.skill_rating.
  const ratingSnapshotRows = (await sql`
    SELECT
      (
        SELECT GREATEST(
          COALESCE(MAX(rating_rapid), 0),
          COALESCE(MAX(rating_blitz), 0),
          COALESCE(MAX(rating_classical), 0)
        )
        FROM external_accounts
        WHERE profile_id = ${user.id} AND verified = true
      ) AS online_best,
      (SELECT ROUND(skill_rating) FROM ratings WHERE profile_id = ${user.id}) AS skill
  `) as Array<{ online_best: number | null; skill: number | null }>;
  const snap = ratingSnapshotRows[0];
  const creatorRating: number | null =
    snap && snap.online_best && snap.online_best > 0
      ? Number(snap.online_best)
      : snap?.skill != null
        ? Number(snap.skill)
        : null;

  try {
    const result = (await sql.begin(async (tx) => {
      // Lock the wallet row; ensure sufficient available_cents.
      const wallets = (await tx`
        SELECT available_cents FROM wallets WHERE profile_id = ${user.id} FOR UPDATE
      `) as Array<{ available_cents: number }>;
      const wallet = wallets[0];
      if (!wallet) throw new HttpError(400, 'no wallet on file');
      if (wallet.available_cents < totalCents) {
        throw new HttpError(402, `insufficient balance — need $${(totalCents / 100).toFixed(2)}`);
      }

      // Reserve: available -= total, pending += total. No ledger entry yet;
      // the ledger only records movements between distinct accounts.
      await tx`
        UPDATE wallets
        SET available_cents = available_cents - ${totalCents},
            pending_cents = pending_cents + ${totalCents}
        WHERE profile_id = ${user.id}
      `;

      const inserted = (await tx`
        INSERT INTO challenges (
          creator_id, fen, pgn_prefix, creator_color, time_control, time_class,
          fee_cents, currency, rating_min, rating_max, games_requested, notes,
          opening_name, eco_code, anonymous, creator_rating
        ) VALUES (
          ${user.id}, ${fenCheck.fen}, ${parsed.pgnPrefix ?? null}, ${parsed.creatorColor},
          ${parsed.timeControl}, ${parsed.timeClass},
          ${parsed.feeCents}, 'USD', ${parsed.ratingMin}, ${parsed.ratingMax},
          ${parsed.gamesRequested}, ${parsed.notes ?? null},
          ${detected?.name ?? null}, ${detected?.ecoCode ?? null},
          ${parsed.anonymous ?? false}, ${creatorRating}
        )
        RETURNING id
      `) as Array<{ id: string }>;
      const row = inserted[0];
      if (!row) throw new HttpError(500, 'insert failed');
      return row.id;
    })) as string;

    return NextResponse.json({ id: result });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[challenges:POST] error', err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
