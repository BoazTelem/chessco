// Palette used by the Chessco chessboard mark. Index into this from GRID.
const COLORS = ['#14100A', '#2A1F05', '#5C4506', '#EAB308'] as const;

// 8x8 grid forming the Chessco "C" — two gold bands top/bottom, dark interior cutout.
const GRID: ReadonlyArray<ReadonlyArray<number>> = [
  [1, 0, 3, 2, 3, 2, 3, 0],
  [0, 3, 2, 3, 2, 3, 2, 1],
  [1, 2, 3, 0, 1, 0, 1, 0],
  [0, 3, 2, 1, 0, 1, 0, 1],
  [1, 2, 3, 0, 1, 0, 1, 0],
  [0, 3, 2, 1, 0, 1, 0, 1],
  [1, 2, 3, 2, 3, 2, 3, 0],
  [0, 1, 2, 3, 2, 3, 2, 1],
];

type MarkVariant = 'solid' | 'float' | 'glyph';

type MarkProps = {
  className?: string;
  title?: string;
  decorative?: boolean;
  // 'solid' = full 8x8 board.
  // 'float' = drop palette 0/1 (dim surround); C strokes float on background.
  // 'glyph' = same silhouette as float, but every C cell rendered in gold
  //           — no mid-brown alternation. Used at small sizes (favicon ≤32)
  //           where the chess parity isn't legible anyway.
  variant?: MarkVariant;
};

function MarkSvg({
  className,
  title = 'Chessco',
  decorative = false,
  variant = 'solid',
}: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      className={className}
      shapeRendering="crispEdges"
      {...(decorative
        ? { 'aria-hidden': true, focusable: false }
        : { role: 'img', 'aria-label': title })}
    >
      {!decorative && <title>{title}</title>}
      {GRID.flatMap((row, y) =>
        row.map((c, x) => {
          if ((variant === 'float' || variant === 'glyph') && c < 2) return null;
          const fill = variant === 'glyph' ? COLORS[3] : COLORS[c];
          return (
            <rect key={`${x}-${y}`} x={x * 32} y={y * 32} width={32} height={32} fill={fill} />
          );
        }),
      )}
    </svg>
  );
}

export function ChesscoMark(props: { className?: string; title?: string; variant?: MarkVariant }) {
  return <MarkSvg className={props.className} title={props.title} variant={props.variant} />;
}

export function ChesscoLockup({
  className,
  markClassName,
  wordmarkClassName,
}: {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <MarkSvg decorative className={markClassName ?? 'h-[1.5em] w-[1.5em] shrink-0'} />
      <span
        className={
          wordmarkClassName ?? 'font-display font-medium uppercase tracking-[0.2em] text-accent'
        }
      >
        Chessco
      </span>
    </span>
  );
}
