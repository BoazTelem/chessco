'use client';

/**
 * EvalBar — vertical advantage indicator for the review board.
 * White's share grows from the bottom (mate-for-white = full white),
 * Black's share fills from the top. Clamped to ±8 pawns so single-move
 * spikes don't dwarf normal eval swings.
 */

interface Props {
  cp: number | null | undefined;
  mate: number | null | undefined;
  heightPx: number;
}

const CLAMP_CP = 800;

export function EvalBar({ cp, mate, heightPx }: Props) {
  // Map score → 0..1 (1 = full white advantage).
  let whiteFrac: number;
  if (typeof mate === 'number' && mate !== 0) {
    whiteFrac = mate > 0 ? 1 : 0;
  } else if (typeof cp === 'number') {
    const c = Math.max(-CLAMP_CP, Math.min(CLAMP_CP, cp));
    whiteFrac = (c + CLAMP_CP) / (CLAMP_CP * 2);
  } else {
    whiteFrac = 0.5;
  }

  return (
    <div
      className="relative flex flex-col rounded-sm border border-border bg-neutral-900"
      style={{ width: 18, height: heightPx }}
      aria-label="Stockfish evaluation"
      title={formatEval(cp, mate)}
    >
      <div
        className="bg-neutral-100"
        style={{
          height: `${whiteFrac * 100}%`,
          marginTop: 'auto',
          transition: 'height 200ms ease',
        }}
      />
      <span
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[9px] font-mono font-semibold"
        style={{
          // Label always on the opposite side from the bigger half so it
          // doesn't disappear inside its own colour.
          top: whiteFrac > 0.5 ? 2 : undefined,
          bottom: whiteFrac > 0.5 ? undefined : 2,
          color: whiteFrac > 0.5 ? '#111' : '#eee',
        }}
      >
        {formatEval(cp, mate)}
      </span>
    </div>
  );
}

function formatEval(cp: number | null | undefined, mate: number | null | undefined): string {
  if (typeof mate === 'number' && mate !== 0) return `M${Math.abs(mate)}`;
  if (typeof cp !== 'number') return '—';
  const pawns = cp / 100;
  if (Math.abs(pawns) < 0.05) return '0.0';
  return pawns >= 0 ? `+${pawns.toFixed(1)}` : pawns.toFixed(1);
}
