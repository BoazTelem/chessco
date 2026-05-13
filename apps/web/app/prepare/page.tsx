import Link from 'next/link';
import { getUser } from '@/lib/auth';
import { ChesscoMark } from '@/lib/logo';
import { PrepareEntryForm } from './entry-form';

export const metadata = {
  title: 'Prepare — opening tree and leaks for any opponent',
  description:
    "Enter your opponent's chess.com or Lichess username to see their opening tree. Sign in to correlate their leaks against your repertoire.",
};

export default async function PreparePage() {
  const user = await getUser();

  return (
    <main className="container mx-auto flex min-h-screen flex-col items-center px-4 py-16">
      <div className="flex w-full max-w-2xl flex-col items-center gap-8 text-center">
        <Link href="/" aria-label="Chessco home" className="transition hover:opacity-80">
          <ChesscoMark variant="float" className="h-[140px] w-[140px]" />
        </Link>

        <div className="space-y-3">
          <h1 className="font-display text-4xl font-bold tracking-tight md:text-5xl">
            Prepare against an opponent
          </h1>
          <p className="text-base text-muted-foreground md:text-lg">
            Enter their chess.com or Lichess username. The opening tree is free for everyone.
            {user
              ? ' Your imported games are used to correlate their leaks with your repertoire.'
              : ' Sign in to unlock personalized leak detection and surprise lines.'}
          </p>
        </div>

        <PrepareEntryForm />

        <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
          <p>
            Don&rsquo;t know their account yet?{' '}
            <Link href="/scout" className="text-accent hover:underline">
              Scout the player by name
            </Link>
            .
          </p>
          {user ? null : (
            <p>
              <Link href="/signup" className="text-accent hover:underline">
                Create an account
              </Link>{' '}
              to see the full report.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
