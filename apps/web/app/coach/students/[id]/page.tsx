/**
 * /coach/students/[id]: per-student detail. Spec §6 Phase 6.
 *
 * Shows the student's recent prep reports + completed matches + ratings.
 * Access gated by an active row in coach_students.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata: Metadata = {
  title: 'Student detail · Chessco coach',
  robots: { index: false, follow: false },
};

interface StudentBundle {
  studentName: string | null;
  status: string;
  rating: { skill_rating: string; trust_tier: string } | null;
  recentReports: Array<{
    id: string;
    target_handle_normalized: string | null;
    status: string;
    created_at: string;
  }>;
  recentMatches: Array<{ id: string; status: string; fee_cents: number; created_at: string }>;
}

async function loadStudent(coachId: string, studentId: string): Promise<StudentBundle | null> {
  const sql = getPracticeDb();

  const relationship = await sql<{ status: string; display_name: string | null }[]>`
    SELECT cs.status, p.display_name
    FROM coach_students cs
    JOIN profiles p ON p.id = cs.student_profile_id
    WHERE cs.coach_profile_id = ${coachId}::uuid
      AND cs.student_profile_id = ${studentId}::uuid
    LIMIT 1
  `;
  const rel = relationship[0];
  if (!rel) return null;

  const ratings = await sql<{ skill_rating: string; trust_tier: string }[]>`
    SELECT skill_rating::text, trust_tier
    FROM ratings WHERE profile_id = ${studentId}::uuid
  `;

  const reports = await sql<StudentBundle['recentReports']>`
    SELECT id::text, target_handle_normalized, status, created_at::text
    FROM prep_reports
    WHERE requested_by = ${studentId}::uuid
    ORDER BY created_at DESC
    LIMIT 10
  `;

  const matches = await sql<StudentBundle['recentMatches']>`
    SELECT id::text, status, fee_cents, created_at::text
    FROM matches
    WHERE creator_id = ${studentId}::uuid OR opponent_id = ${studentId}::uuid
    ORDER BY created_at DESC
    LIMIT 10
  `;

  return {
    studentName: rel.display_name,
    status: rel.status,
    rating: ratings[0] ?? null,
    recentReports: reports,
    recentMatches: matches,
  };
}

export default async function CoachStudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getUser();
  if (!user) redirect('/login?next=/coach/students');
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const bundle = await loadStudent(user.id, id);
  if (!bundle) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Student</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          {bundle.studentName ?? 'Unnamed student'}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Coaching relationship status: {bundle.status}
          {bundle.rating
            ? ` · skill ${Math.round(Number(bundle.rating.skill_rating))} · ${bundle.rating.trust_tier}`
            : ''}
        </p>
      </header>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">Recent prep reports</h2>
        {bundle.recentReports.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No reports yet.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {bundle.recentReports.map((r) => (
              <li
                key={r.id}
                className="flex items-baseline justify-between rounded-md border border-border bg-card px-3 py-2"
              >
                <span>
                  vs. {r.target_handle_normalized ?? 'unknown'} ·{' '}
                  <span className="text-xs text-muted-foreground">{r.status}</span>
                </span>
                <Link href={`/reports/${r.id}`} className="text-xs hover:underline">
                  Open
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">Recent matches</h2>
        {bundle.recentMatches.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No matches yet.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {bundle.recentMatches.map((m) => (
              <li
                key={m.id}
                className="flex items-baseline justify-between rounded-md border border-border bg-card px-3 py-2"
              >
                <span>
                  {m.status} ·{' '}
                  <span className="text-xs text-muted-foreground">{m.created_at.slice(0, 10)}</span>
                </span>
                <Link href={`/practice/g/${m.id}/review`} className="text-xs hover:underline">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
