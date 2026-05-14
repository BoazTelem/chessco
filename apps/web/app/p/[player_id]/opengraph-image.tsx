import { ImageResponse } from 'next/og';
import { getPlayerByParam } from '@/lib/seo/player-fetch';
import { playerDisplayName } from '@/lib/seo/slug';

export const alt = 'Chessco player profile';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const revalidate = 86400;

type RatingTile = { label: string; value: number | null };

export default async function PlayerOgImage({
  params,
}: {
  params: Promise<{ player_id: string }>;
}) {
  const { player_id } = await params;
  const player = await getPlayerByParam(player_id);

  if (!player) {
    return new ImageResponse(<FallbackCard />, { ...size });
  }

  const display = playerDisplayName(player.name);
  const tiles: RatingTile[] = [
    { label: 'Standard', value: player.rating_standard },
    { label: 'Rapid', value: player.rating_rapid },
    { label: 'Blitz', value: player.rating_blitz },
  ];

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
        Chessco · Scout
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          flex: 1,
          gap: 24,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Badge>{player.federation_id}</Badge>
          {player.title ? <Badge accent>{player.title}</Badge> : null}
          {player.country ? <Badge>{player.country}</Badge> : null}
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 92,
            fontWeight: 700,
            letterSpacing: -3,
            lineHeight: 1.0,
          }}
        >
          {display}
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 24,
            color: '#a1a1aa',
            letterSpacing: 1,
          }}
        >
          {player.federation_id} ID {player.federation_player_id}
          {player.birth_year ? ` · born ${player.birth_year}` : ''}
        </div>

        <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>
          {tiles.map((t) => (
            <RatingTile key={t.label} label={t.label} value={t.value} />
          ))}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          fontSize: 22,
          color: '#a1a1aa',
          letterSpacing: 1,
        }}
      >
        Find their Lichess and chess.com accounts · chessco.org
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

function RatingTile({ label, value }: RatingTile) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '18px 28px',
        borderRadius: 12,
        border: '1px solid #1f2937',
        background: 'rgba(255, 255, 255, 0.03)',
        minWidth: 180,
      }}
    >
      <div style={{ display: 'flex', fontSize: 16, color: '#a1a1aa', letterSpacing: 2 }}>
        {label.toUpperCase()}
      </div>
      <div
        style={{
          display: 'flex',
          fontSize: 56,
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

function FallbackCard() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: '#070b15',
        padding: 72,
        color: '#fafafa',
        justifyContent: 'center',
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
        Chessco
      </div>
      <div style={{ display: 'flex', fontSize: 64, fontWeight: 700, marginTop: 24 }}>
        Player profile
      </div>
      <div style={{ display: 'flex', fontSize: 24, color: '#a1a1aa', marginTop: 12 }}>
        Scout. Prepare. Win.
      </div>
    </div>
  );
}
