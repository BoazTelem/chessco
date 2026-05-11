import { brand } from '@chessco/ui';

export default function HomePage() {
  return (
    <main className="container mx-auto flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <div className="flex max-w-3xl flex-col items-center gap-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">{brand.name}</p>

        <h1 className="font-display text-5xl font-bold tracking-tight md:text-7xl">
          {brand.slogan}
        </h1>

        <p className="max-w-2xl text-lg text-muted-foreground md:text-xl">{brand.description}</p>

        <div className="mt-8 flex flex-col gap-3 text-sm">
          <div className="rounded-lg border border-border bg-card px-6 py-4 text-muted-foreground">
            <span className="font-medium text-foreground">Phase 0 — Foundation.</span> Building
            auth, account linking, and own-game import.
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>Scout</span>
            <span className="text-accent">→</span>
            <span>Find</span>
            <span className="text-accent">→</span>
            <span>Practice</span>
            <span className="text-accent">→</span>
            <span>Pay</span>
            <span className="text-accent">→</span>
            <span>Improve</span>
          </div>
        </div>
      </div>
    </main>
  );
}
