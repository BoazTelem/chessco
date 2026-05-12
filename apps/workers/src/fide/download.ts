/**
 * Downloads FIDE rating-list zip files and yields the inner XML files
 * as streams (we do NOT load the XML into memory).
 *
 * FIDE publishes monthly at:
 *   http://ratings.fide.com/download/standard_rating_list_xml.zip
 *   http://ratings.fide.com/download/rapid_rating_list_xml.zip
 *   http://ratings.fide.com/download/blitz_rating_list_xml.zip
 *
 * Each zip contains one XML file (~50–150MB uncompressed) with ~400k players.
 */
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

export type RatingClass = 'standard' | 'rapid' | 'blitz';

const SOURCES: Record<RatingClass, string> = {
  standard: 'http://ratings.fide.com/download/standard_rating_list_xml.zip',
  rapid: 'http://ratings.fide.com/download/rapid_rating_list_xml.zip',
  blitz: 'http://ratings.fide.com/download/blitz_rating_list_xml.zip',
};

export type DownloadedFile = {
  ratingClass: RatingClass;
  zipPath: string;
  /** Cleanup function — deletes the temp dir. Caller MUST invoke when done. */
  cleanup: () => Promise<void>;
};

/**
 * Download all three FIDE zip files into a temp dir and return paths.
 * Streams the HTTP response directly to disk — never holds the whole zip
 * in memory.
 */
export async function downloadAll(opts: { log?: (msg: string) => void } = {}): Promise<{
  files: DownloadedFile[];
  bytes: number;
  cleanupAll: () => Promise<void>;
}> {
  const log = opts.log ?? (() => {});
  const tempDir = await mkdtemp(join(tmpdir(), 'chessco-fide-'));
  const files: DownloadedFile[] = [];
  let totalBytes = 0;

  for (const ratingClass of Object.keys(SOURCES) as RatingClass[]) {
    const url = SOURCES[ratingClass];
    const zipPath = join(tempDir, `${ratingClass}.zip`);
    log(`[fide] downloading ${ratingClass} list…`);
    const start = Date.now();

    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'chessco/0.1 (+https://chessco.org)' },
    });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    }

    const writeStream = createWriteStream(zipPath);
    await pipeline(
      Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      writeStream,
    );
    const { size } = await import('node:fs/promises').then((m) => m.stat(zipPath));
    totalBytes += size;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`[fide] ${ratingClass}: ${(size / 1024 / 1024).toFixed(1)}MB in ${elapsed}s`);

    files.push({
      ratingClass,
      zipPath,
      cleanup: async () => rm(zipPath, { force: true }),
    });
  }

  return {
    files,
    bytes: totalBytes,
    cleanupAll: async () => rm(tempDir, { recursive: true, force: true }),
  };
}

/**
 * Open the inner XML stream from a zip file. The caller must consume the
 * stream fully (or destroy it) before opening the next file.
 */
export async function openXmlStream(zipPath: string): Promise<NodeJS.ReadableStream> {
  const directory = await unzipper.Open.file(zipPath);
  const xmlEntry = directory.files.find((f) => f.path.toLowerCase().endsWith('.xml'));
  if (!xmlEntry) {
    throw new Error(`No XML file found in ${zipPath}`);
  }
  return xmlEntry.stream();
}
