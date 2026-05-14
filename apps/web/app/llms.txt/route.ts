import { brand } from '@chessco/ui';

const ORIGIN = (process.env.NEXT_PUBLIC_APP_URL ?? `https://${brand.domain}`).replace(/\/$/, '');

export const revalidate = 604800;

const BODY = `# ${brand.name}

> ${brand.description}

## About
${brand.name} indexes ~762k federation-rated chess players (FIDE, USCF, ECF, DSB, FSI, FFE, ICF) and ~106k online accounts (chess.com, lichess.org). Tournament players use it to scout opponents and prepare opening repertoire.

## URL patterns
- \`${ORIGIN}/p/{slug}\` — federation player profile (slug = \`{kebab-name}-{federation}-{id}\`, e.g. \`/p/telem-boaz-fide-2860740\`)
- \`${ORIGIN}/prepare/chesscom/{handle}\` — opponent prep report for a chess.com account
- \`${ORIGIN}/prepare/lichess/{handle}\` — opponent prep report for a Lichess account

## Key pages
- [${ORIGIN}/](${ORIGIN}/): home — Scout / Prepare / Practice pillars
- [${ORIGIN}/scout](${ORIGIN}/scout): search rated players by name + federation
- [${ORIGIN}/prepare](${ORIGIN}/prepare): enter an online handle to get a prep report

## Optional
- [${ORIGIN}/trust](${ORIGIN}/trust)
- [${ORIGIN}/privacy](${ORIGIN}/privacy)
- [${ORIGIN}/terms](${ORIGIN}/terms)
`;

export function GET() {
  return new Response(BODY, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
