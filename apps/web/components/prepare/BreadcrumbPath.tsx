interface Props {
  sanPath: string[];
  cursor: number;
  onJump: (ply: number) => void;
}

function formatLine(sanPath: string[]): { number: number; white: string; black?: string }[] {
  const rows: { number: number; white: string; black?: string }[] = [];
  for (let i = 0; i < sanPath.length; i += 2) {
    const white = sanPath[i];
    if (white === undefined) break;
    rows.push({ number: i / 2 + 1, white, black: sanPath[i + 1] });
  }
  return rows;
}

export function BreadcrumbPath({ sanPath, cursor, onJump }: Props) {
  const rows = formatLine(sanPath);
  const atStart = cursor === 0;
  const atEnd = cursor === sanPath.length;

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card px-3 py-2 text-xs font-mono">
      <button
        type="button"
        onClick={() => onJump(Math.max(0, cursor - 1))}
        disabled={atStart}
        aria-label="Previous move"
        title="Previous move (←)"
        className="rounded px-1 text-muted-foreground hover:text-accent disabled:cursor-not-allowed disabled:opacity-30"
      >
        ‹
      </button>
      <button
        type="button"
        onClick={() => onJump(Math.min(sanPath.length, cursor + 1))}
        disabled={atEnd}
        aria-label="Next move"
        title="Next move (→)"
        className="rounded px-1 text-muted-foreground hover:text-accent disabled:cursor-not-allowed disabled:opacity-30"
      >
        ›
      </button>
      <button
        type="button"
        onClick={() => onJump(0)}
        className={`rounded px-1 transition ${
          atStart ? 'bg-accent/20 text-accent' : 'text-muted-foreground hover:text-accent'
        }`}
      >
        start
      </button>
      {rows.map((row, ri) => {
        const whitePly = ri * 2 + 1;
        const blackPly = ri * 2 + 2;
        const whiteActive = cursor === whitePly;
        const blackActive = cursor === blackPly;
        const whitePast = cursor >= whitePly;
        const blackPast = row.black !== undefined && cursor >= blackPly;
        return (
          <span key={ri} className="flex items-center gap-1">
            <span className="text-muted-foreground">{row.number}.</span>
            <button
              type="button"
              onClick={() => onJump(whitePly)}
              className={`rounded px-1 transition ${
                whiteActive
                  ? 'bg-accent/20 text-accent'
                  : whitePast
                    ? 'text-foreground hover:text-accent'
                    : 'text-muted-foreground/60 hover:text-accent'
              }`}
            >
              {row.white}
            </button>
            {row.black ? (
              <button
                type="button"
                onClick={() => onJump(blackPly)}
                className={`rounded px-1 transition ${
                  blackActive
                    ? 'bg-accent/20 text-accent'
                    : blackPast
                      ? 'text-foreground hover:text-accent'
                      : 'text-muted-foreground/60 hover:text-accent'
                }`}
              >
                {row.black}
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
