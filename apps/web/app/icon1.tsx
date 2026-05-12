import { ImageResponse } from 'next/og';

// Raster PNG fallbacks for the favicon. Modern browsers prefer /icon.svg (the
// flat-gold glyph), but pinned tabs, OS taskbars, RSS readers, and the PWA
// manifest still want explicit sized PNGs.
//
// Size strategy: at <=32px the chess parity isn't readable and the cell grid
// turns to mud, so we ship the same flat-gold glyph as the SVG. At 48px we
// keep the C texture (mid-brown + gold cells, transparent surround). At
// >=192px the full 8x8 board reads cleanly, so we ship the canonical mark.

const COLORS = ['#14100A', '#2A1F05', '#5C4506', '#EAB308'] as const;
const GOLD = '#EAB308';

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

export function generateImageMetadata() {
  return [
    { id: '16', contentType: 'image/png', size: { width: 16, height: 16 } },
    { id: '32', contentType: 'image/png', size: { width: 32, height: 32 } },
    { id: '48', contentType: 'image/png', size: { width: 48, height: 48 } },
    { id: '192', contentType: 'image/png', size: { width: 192, height: 192 } },
    { id: '512', contentType: 'image/png', size: { width: 512, height: 512 } },
  ];
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const resolvedId = await id;
  const size = parseInt(resolvedId, 10);

  const useGlyph = size <= 32;
  const useFloat = !useGlyph && size <= 48;
  // size >= 192 falls through to solid (full board, no transparency).

  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'transparent',
      }}
    >
      {GRID.map((row, y) => (
        <div key={y} style={{ display: 'flex', flex: 1 }}>
          {row.map((c, x) => {
            const hidden = (useGlyph || useFloat) && c < 2;
            const fill = hidden ? 'transparent' : useGlyph ? GOLD : COLORS[c];
            return <div key={x} style={{ display: 'flex', flex: 1, background: fill }} />;
          })}
        </div>
      ))}
    </div>,
    { width: size, height: size },
  );
}
