interface Props {
  sanPath: string[];
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

export function BreadcrumbPath({ sanPath, onJump }: Props) {
  const rows = formatLine(sanPath);

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card px-3 py-2 text-xs font-mono">
      <button
        type="button"
        onClick={() => onJump(0)}
        className="text-muted-foreground hover:text-accent disabled:opacity-50"
        disabled={sanPath.length === 0}
      >
        start
      </button>
      {rows.map((row, ri) => {
        const whitePly = ri * 2 + 1;
        const blackPly = ri * 2 + 2;
        return (
          <span key={ri} className="flex items-center gap-1">
            <span className="text-muted-foreground">{row.number}.</span>
            <button
              type="button"
              onClick={() => onJump(whitePly)}
              className="text-foreground hover:text-accent"
            >
              {row.white}
            </button>
            {row.black ? (
              <button
                type="button"
                onClick={() => onJump(blackPly)}
                className="text-foreground hover:text-accent"
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
