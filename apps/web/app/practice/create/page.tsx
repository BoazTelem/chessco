import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { REFERRAL_BONUS_CAP } from '@/lib/credits';
import { CreatePositionForm } from '@/components/practice/CreatePositionForm';
import { InvitePicker } from '@/components/practice/InvitePicker';

export const metadata = {
  title: 'Practice — create a position',
};

// No page-level `revalidate`: getUser() reads cookies, mixing them with
// revalidate breaks the logged-in/out toggle (same gotcha as /scout).

export default async function PracticeCreatePage() {
  const user = await requireUser();
  const supabase = await createClient();

  // Three parallel reads: wallet + the user's linked online ratings + their
  // Chessco internal skill rating. We use the highest rapid rating across
  // verified online accounts as the default rating-band center; if none are
  // linked, fall back to skill_rating (Chessco's Glicko, default 1500).
  const sql = getPracticeDb();
  const [{ data: wallet }, { data: linked }, { data: ratingRow }, referralRows] = await Promise.all(
    [
      supabase.from('wallets').select('credit_available').eq('profile_id', user.id).maybeSingle(),
      supabase
        .from('external_accounts')
        .select('rating_rapid, rating_blitz, rating_classical')
        .eq('profile_id', user.id)
        .eq('verified', true),
      supabase.from('ratings').select('skill_rating').eq('profile_id', user.id).maybeSingle(),
      sql`
        SELECT
          p.referral_code,
          COALESCE((
            SELECT SUM(amount)::int FROM credit_grants
            WHERE profile_id = ${user.id} AND source_type = 'referral'
          ), 0) AS referral_credits_earned
        FROM profiles p WHERE p.id = ${user.id} LIMIT 1
      ` as unknown as Promise<Array<{ referral_code: string; referral_credits_earned: number }>>,
    ],
  );
  const referralRow = referralRows[0];
  const referralCode = referralRow?.referral_code ?? '';
  const referralCreditsEarned = Number(referralRow?.referral_credits_earned ?? 0);

  const onlineBest = (linked ?? []).reduce<number | null>((best, row) => {
    const r = row.rating_rapid ?? row.rating_blitz ?? row.rating_classical ?? null;
    if (r == null) return best;
    return best == null || r > best ? r : best;
  }, null);
  const skillFallback =
    ratingRow?.skill_rating != null ? Math.round(Number(ratingRow.skill_rating)) : null;
  const userRating = onlineBest ?? skillFallback;

  return (
    <div className="min-h-screen">
      <main className="container mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Practice</p>
          <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
            Create a position
          </h1>
          <p className="text-sm text-muted-foreground">
            Set up any FEN, choose a time control, and publish free or paid practice. Strong
            opponents will pick it up from the lobby and play it against you.
          </p>
        </div>

        <CreatePositionForm
          creditAvailable={wallet?.credit_available ?? 0}
          userRating={userRating}
          referralCode={referralCode}
          referralCreditsEarned={referralCreditsEarned}
          referralCreditsCap={REFERRAL_BONUS_CAP}
        />

        <div className="mt-6">
          <InvitePicker
            currentUserId={user.id}
            creditAvailable={wallet?.credit_available ?? 0}
            referralCode={referralCode}
            referralCreditsEarned={referralCreditsEarned}
            referralCreditsCap={REFERRAL_BONUS_CAP}
          />
        </div>
      </main>
    </div>
  );
}
