/**
 * /coach/students — coach dashboard listing active student relationships.
 * Spec §6 Phase 6.
 *
 * Reads from the `coach_students` table (added in WS-10). Coach role is
 * implicit — anyone can list students they invited. Future work: dedicated
 * coach signup flow with verification.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'My students · Chessco coach',
  robots: { index: false, follow: false },
};

interface StudentRow {
  id: string;
  student_profile_id: string;
  student_name: string | null;
  status: string;
  invited_at: string;
  accepted_at: string | null;
}

async function loadStudents(coachId: string): Promise<StudentRow[]> {
  const sql = getPracticeDb();
  return sql<StudentRow[]>`
    SELECT cs.id::text,
           cs.student_profile_id::text,
           p.display_name AS student_name,
           cs.status,
           cs.invited_at::text,
           cs.accepted_at::text
    FROM coach_students cs
    JOIN profiles p ON p.id = cs.student_profile_id
    WHERE cs.coach_profile_id = ${coachId}::uuid
    ORDER BY
      CASE cs.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      cs.invited_at DESC
  `;
}

export default async function CoachStudentsPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/coach/students');

  const students = await loadStudents(user.id);
  const active = students.filter((s) => s.status === 'active');
  const pending = students.filter((s) => s.status === 'pending');
  const ended = students.filter((s) => s.status === 'ended');

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Coach</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">My students</h1>
      </header>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">Active ({active.length})</h2>
        {active.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
            No active students. Invite one via{' '}
            <code className="rounded bg-muted px-1 py-0.5">POST /api/coach/invite</code> (endpoint
            lands with the coach signup flow).
          </p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {active.map((s) => (
              <li key={s.id} className="rounded-md border border-border bg-card px-4 py-3">
                <div className="flex items-baseline justify-between">
                  <p className="font-semibold">{s.student_name ?? 'Unnamed student'}</p>
                  <Link
                    href={`/coach/students/${s.student_profile_id}`}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    Open student
                  </Link>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Active since {s.accepted_at ? s.accepted_at.slice(0, 10) : '—'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pending.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-display text-lg font-semibold text-muted-foreground">
            Pending ({pending.length})
          </h2>
          <ul className="mt-3 grid gap-2 text-sm">
            {pending.map((s) => (
              <li key={s.id} className="rounded-md border border-border bg-card px-4 py-2">
                {s.student_name ?? 'Unnamed'} —{' '}
                <span className="text-xs text-muted-foreground">
                  invited {s.invited_at.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ended.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-display text-lg font-semibold text-muted-foreground">
            Past students ({ended.length})
          </h2>
          <ul className="mt-3 grid gap-2 text-sm">
            {ended.slice(0, 20).map((s) => (
              <li
                key={s.id}
                className="rounded-md border border-border bg-card px-4 py-2 text-muted-foreground"
              >
                {s.student_name ?? 'Unnamed'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
