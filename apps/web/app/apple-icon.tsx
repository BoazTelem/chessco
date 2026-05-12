import { ImageResponse } from 'next/og';

// 180x180 PNG that iOS uses when the user pins chessco.org to their home
// screen. We bake in a dark backdrop so the mark reads against any wallpaper.

const COLORS = ['#14100A', '#2A1F05', '#5C4506', '#EAB308'] as const;

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

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          background: '#070b15',
        }}
      >
        {GRID.map((row, y) => (
          <div key={y} style={{ display: 'flex', flex: 1 }}>
            {row.map((c, x) => (
              <div key={x} style={{ display: 'flex', flex: 1, background: COLORS[c] }} />
            ))}
          </div>
        ))}
      </div>
    ),
    { ...size },
  );
}
