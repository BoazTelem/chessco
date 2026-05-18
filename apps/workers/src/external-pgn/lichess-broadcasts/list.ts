/**
 * List Lichess broadcasts (official tournaments). Read-only probe — counterpart
 * of twic/probe.ts. Useful to discover broadcast IDs to feed to ingest.ts.
 *
 * Lichess endpoints:
 *   GET https://lichess.org/api/broadcast               (ndjson stream)
 *     Official tournaments paginated by `nb` (default 20, max 100 per page).
 *   GET https://lichess.org/api/broadcast/top           (curated highlights)
 *
 * Both endpoints stream ndjson where each line is a tournament object with
 * { tour: { id, name, slug, ... }, rounds: [ { id, name, finished, ... } ] }.
 *
 * Usage:
 *   pnpm --filter @chessco/workers external:broadcasts:list -- --nb 20
 *   pnpm --filter @chessco/workers external:broadcasts:list -- --top
 *
 * Output: one line per broadcast (tour_id, slug, round_count, sample round_id).
 * Pipe through grep / awk to extract IDs for downstream ingest.
 */
import 'dotenv/config';

const USER_AGENT = 'chessco/0.1 (+https://chessco.org)';
const LICHESS_BROADCAST_LIST = 'https://lichess.org/api/broadcast';
const LICHESS_BROADCAST_TOP = 'https://lichess.org/api/broadcast/top';

interface BroadcastRound {
  id: string;
  name: string;
  slug?: string;
  startsAt?: number;
  finished?: boolean;
}

interface BroadcastTour {
  id: string;
  name: string;
  slug: string;
  description?: string;
  url?: string;
  tier?: number;
}

interface BroadcastEntry {
  tour: BroadcastTour;
  rounds: BroadcastRound[];
}

interface CliArgs {
  nb: number;
  top: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { nb: 20, top: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      continue;
    } else if (a === '--nb' && argv[i + 1]) {
      out.nb = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--top') {
      out.top = true;
    } else {
      throw new Error(`Unrecognized arg: ${a}`);
    }
  }
  if (!Number.isFinite(out.nb) || out.nb < 1) {
    throw new Error('--nb must be a positive integer');
  }
  return out;
}

/**
 * Stream the ndjson response body line-by-line. The endpoint emits one
 * JSON object per line; we yield BroadcastEntry per line so callers can
 * process incrementally.
 */
export async function* streamBroadcasts(url: string): AsyncGenerator<BroadcastEntry> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/x-ndjson' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as BroadcastEntry;
      } catch (err) {
        console.warn(`[broadcasts:list] skip unparseable line: ${(err as Error).message}`);
      }
    }
  }
  // Flush any trailing partial line (rare but possible if the stream
  // ended without a final newline).
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as BroadcastEntry;
    } catch {
      /* swallow */
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.top ? LICHESS_BROADCAST_TOP : LICHESS_BROADCAST_LIST;
  const url = `${baseUrl}?nb=${args.nb}`;
  console.log(`[broadcasts:list] streaming ${url}`);

  let count = 0;
  for await (const entry of streamBroadcasts(url)) {
    count++;
    const finishedRounds = entry.rounds.filter((r) => r.finished).length;
    const liveRounds = entry.rounds.length - finishedRounds;
    const sampleRound = entry.rounds[0];
    console.log(
      `  · ${entry.tour.id}  tier=${entry.tour.tier ?? '?'}  ${entry.tour.name}  ` +
        `rounds=${entry.rounds.length} (live=${liveRounds}, done=${finishedRounds})` +
        (sampleRound ? `  first_round=${sampleRound.id}` : ''),
    );
  }
  console.log(`\n[broadcasts:list] ${count} broadcasts listed`);
}

const isCli = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (isCli) {
  main().catch((err) => {
    console.error('[broadcasts:list] failed:', err);
    process.exit(1);
  });
}
