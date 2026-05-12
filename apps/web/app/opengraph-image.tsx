import { ImageResponse } from 'next/og';

// 1200x630 social card. Mark on the left, slogan + subline on the right,
// dark backdrop. Next.js auto-injects <meta property="og:image"> and the
// twitter:image tag for every page, so this becomes the default link
// preview for the whole site.

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

export const alt = 'Chessco — Scout. Prepare. Win.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: '100%',
          background: '#070b15',
          padding: 72,
          alignItems: 'center',
          gap: 56,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: 280,
            height: 280,
            flexShrink: 0,
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, color: '#fafafa' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: 8,
              color: '#EAB308',
              textTransform: 'uppercase',
            }}
          >
            Chessco
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              fontSize: 88,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.0,
            }}
          >
            <div style={{ display: 'flex' }}>Scout. Prepare.</div>
            <div style={{ display: 'flex' }}>Win.</div>
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              color: '#a1a1aa',
              maxWidth: 640,
              lineHeight: 1.35,
              marginTop: 8,
            }}
          >
            Find your next opponent&apos;s online games. Build a battle plan.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
