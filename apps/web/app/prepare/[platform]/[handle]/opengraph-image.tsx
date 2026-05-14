import { ImageResponse } from 'next/og';
import { probeChesscomOne, probeLichess, type ProbeHit } from '@/lib/scout/lazy-probe';

export const alt = 'Chessco prep target';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const revalidate = 86400;

const PLATFORM_DISPLAY: Record<string, string> = {
  chesscom: 'chess.com',
  lichess: 'lichess.org',
};

async function probeWithTimeout(
  platformSlug: string,
  handle: string,
  ms: number,
): Promise<ProbeHit | null> {
  const probe: Promise<ProbeHit | null> =
    platformSlug === 'chesscom'
      ? probeChesscomOne(handle)
      : platformSlug === 'lichess'
        ? probeLichess([handle]).then((arr) => arr[0] ?? null)
        : Promise.resolve(null);

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([probe, timeout]);
}

export default async function PrepareOgImage({
  params,
}: {
  params: Promise<{ platform: string; handle: string }>;
}) {
  const { platform: platformSlug, handle: rawHandle } = await params;
  const display = PLATFORM_DISPLAY[platformSlug] ?? platformSlug;
  const handle = decodeURIComponent(rawHandle);
  const hit = await probeWithTimeout(platformSlug, handle, 2000);

  const tiles =
    hit !== null
      ? [
          { label: 'Bullet', value: hit.rating_bullet },
          { label: 'Blitz', value: hit.rating_blitz },
          { label: 'Rapid', value: hit.rating_rapid },
          { label: 'Classical', value: hit.rating_classical },
        ].filter((t) => t.value !== null)
      : [];

  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: '#070b15',
        padding: 72,
        color: '#fafafa',
      }}
    >
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
        Chessco · Prep target
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          flex: 1,
          gap: 22,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Badge accent>{display}</Badge>
          {hit?.title ? <Badge accent>{hit.title}</Badge> : null}
          {hit?.country ? <Badge>{hit.country}</Badge> : null}
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 96,
            fontWeight: 700,
            letterSpacing: -3,
            lineHeight: 1.0,
          }}
        >
          {handle}
        </div>

        {hit?.claimed_name ? (
          <div style={{ display: 'flex', fontSize: 28, color: '#a1a1aa' }}>{hit.claimed_name}</div>
        ) : null}

        {tiles.length > 0 ? (
          <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap' }}>
            {tiles.map((t) => (
              <RatingTile key={t.label} label={t.label} value={t.value} />
            ))}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          fontSize: 22,
          color: '#a1a1aa',
          letterSpacing: 1,
        }}
      >
        Opening tree · repertoire leaks · prep report · chessco.org
      </div>
    </div>,
    { ...size },
  );
}

function Badge({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        fontSize: 22,
        fontWeight: 600,
        padding: '6px 14px',
        borderRadius: 8,
        border: `1px solid ${accent ? '#EAB308' : '#27272a'}`,
        color: accent ? '#EAB308' : '#e4e4e7',
        background: accent ? 'rgba(234, 179, 8, 0.08)' : 'rgba(255, 255, 255, 0.04)',
        letterSpacing: 1,
      }}
    >
      {children}
    </div>
  );
}

function RatingTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 24px',
        borderRadius: 12,
        border: '1px solid #1f2937',
        background: 'rgba(255, 255, 255, 0.03)',
        minWidth: 150,
      }}
    >
      <div style={{ display: 'flex', fontSize: 14, color: '#a1a1aa', letterSpacing: 2 }}>
        {label.toUpperCase()}
      </div>
      <div
        style={{
          display: 'flex',
          fontSize: 48,
          fontWeight: 700,
          color: '#fafafa',
          marginTop: 4,
        }}
      >
        {value ?? '—'}
      </div>
    </div>
  );
}
