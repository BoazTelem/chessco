'use client';

import { Chess } from 'chess.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OpeningTreeBoard } from '@/components/prepare/OpeningTreeBoard';
import { BreadcrumbPath } from '@/components/prepare/BreadcrumbPath';
import { FetchProgressBar } from '@/components/prepare/FetchProgressBar';
import { MoveListPanel } from '@/components/prepare/MoveListPanel';
import { TreeFilters } from '@/components/prepare/TreeFilters';
import { fetchChesscomGames } from '@/lib/prepare/fetch-chesscom';
import { bumpCorpusPriority } from '@/lib/prepare/fetch-corpus';
import { fetchLichessGames, lichessProfileGameCount } from '@/lib/prepare/fetch-lichess';
import { normalizeFenKey } from '@/lib/prepare/parse-pgn';
import { parseGameOffThread, terminateParseWorker } from '@/lib/prepare/parse-worker-client';
import { buildTree, gamePassesFilters, windowBounds } from '@/lib/prepare/tree-builder';
import {
  flushStore,
  getStore,
  hydrateFromCorpus,
  hydrateStore,
  ingestGame,
  listGames,
} from '@/lib/prepare/storage';
import { loadCachedGames, loadCachedMeta, type CachedMeta } from '@/lib/prepare/persist';
import type {
  FetchProgress,
  Filters,
  GameRecord,
  NextMoveStats,
  Platform,
  TreeNode,
} from '@/lib/prepare/types';

const REBUILD_BATCH = 25;
const REBUILD_THROTTLE_MS = 250;

const SHORT_DATE = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

function formatShortDate(d: Date): string {
  return SHORT_DATE.format(d);
}

function formatTimeAgo(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatShortDate(from);
}

const DEFAULT_FILTERS: Filters = {
  color: 'white',
  timeClasses: new Set(),
  window: 3,
  customSince: null,
  customUntil: null,
};

interface Props {
  platform: Platform;
  handle: string;
  signedIn: boolean;
}

type CorpusSyncStatus = 'idle' | 'uploading' | 'ready' | 'failed' | 'skipped';

const CORPUS_SYNC_GAME_CAP = 500;
const CORPUS_SYNC_PLY_CAP = 30_000;

export function OpeningTreeSection({ platform, handle, signedIn }: Props) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [progress, setProgress] = useState<FetchProgress>({
    phase: 'idle',
    fetchedGames: 0,
    estimatedTotal: null,
    currentLabel: null,
    errorMessage: null,
  });
  const [rebuildTick, setRebuildTick] = useState(0);
  const [sanPath, setSanPath] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hoveredMove, setHoveredMove] = useState<NextMoveStats | null>(null);
  const [cachedMeta, setCachedMeta] = useState<CachedMeta | null>(null);
  const [corpusSync, setCorpusSync] = useState<CorpusSyncStatus>(signedIn ? 'idle' : 'skipped');
  const abortRef = useRef<AbortController | null>(null);
  const lastRebuildRef = useRef(0);
  const newSinceLastRebuildRef = useRef(0);
  const platformLabel = platform === 'chess.com' ? 'chess.com' : 'Lichess';

  // games lives in a module-level Map; rebuildTick is the explicit sentinel
  // that the fetch loop bumps so we re-read it after each batch of ingests.
  const games = useMemo(
    () => listGames(platform, handle),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [platform, handle, rebuildTick],
  );

  const tree = useMemo(() => buildTree(games, { filters }), [games, filters]);

  const walker = useMemo(() => {
    const w = new Chess();
    for (let i = 0; i < cursor; i += 1) {
      const san = sanPath[i];
      if (san === undefined) break;
      try {
        w.move(san);
      } catch {
        break;
      }
    }
    return w;
  }, [sanPath, cursor]);

  const walkerFen = walker.fen();
  const currentFenKey = useMemo(() => normalizeFenKey(walkerFen), [walkerFen]);

  const currentNode: TreeNode | null = tree.get(currentFenKey) ?? null;
  const topMoves = useMemo<NextMoveStats[]>(() => {
    if (!currentNode) return [];
    return [...currentNode.children.values()]
      .sort((a, b) => b.weightedScore - a.weightedScore)
      .slice(0, 3);
  }, [currentNode]);

  const samplesForMove = useCallback(
    (move: NextMoveStats): GameRecord[] => {
      const store = getStore(platform, handle);
      const out: GameRecord[] = [];
      for (const id of move.recentGameIds) {
        const g = store.games.get(id);
        if (g) out.push(g);
      }
      return out;
    },
    [platform, handle],
  );

  const filteredGameCount = useMemo(() => {
    const now = new Date();
    let n = 0;
    for (const g of games) if (gamePassesFilters(g, filters, now)) n += 1;
    return n;
  }, [games, filters]);

  const triggerRebuild = useCallback((force: boolean) => {
    const now = Date.now();
    newSinceLastRebuildRef.current += 1;
    if (
      force ||
      newSinceLastRebuildRef.current >= REBUILD_BATCH ||
      now - lastRebuildRef.current > REBUILD_THROTTLE_MS
    ) {
      newSinceLastRebuildRef.current = 0;
      lastRebuildRef.current = now;
      setRebuildTick((t) => t + 1);
    }
  }, []);

  const startFetch = useCallback(
    async (mode: 'fresh' | 'extend', extendFrom?: Date) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const now = new Date();
      const bounds = windowBounds(filters, now);
      const store = getStore(platform, handle);

      type Range = { since: Date; until: Date; label: string | null };
      const ranges: Range[] = [];

      if (mode === 'extend') {
        // Explicit back-extension triggered by the filter-widening path.
        const since = extendFrom ?? bounds.since;
        ranges.push({ since, until: bounds.until, label: 'Extending window…' });
      } else {
        const cachedLatest = store.latest;
        const cachedEarliest = store.earliest;
        const haveCache = cachedLatest !== null && store.games.size > 0;

        if (!haveCache) {
          ranges.push({ since: bounds.since, until: bounds.until, label: null });
        } else {
          // Forward gap — pull only games newer than the cache.
          if (cachedLatest < bounds.until) {
            ranges.push({
              since: new Date(cachedLatest.getTime() + 1),
              until: bounds.until,
              label: `Fetching new games since ${formatShortDate(cachedLatest)}…`,
            });
          }
          // Back gap — filter window now reaches earlier than what we have.
          if (cachedEarliest && bounds.since < cachedEarliest) {
            ranges.push({
              since: bounds.since,
              until: new Date(cachedEarliest.getTime() - 1),
              label: `Fetching older games before ${formatShortDate(cachedEarliest)}…`,
            });
          }
        }
      }

      if (ranges.length === 0) {
        setProgress({
          phase: 'done',
          fetchedGames: store.games.size,
          estimatedTotal: null,
          currentLabel: 'Already up to date',
          errorMessage: null,
        });
        // Already up to date — still attempt a corpus sync so a reload of
        // a stuck/old report can wake the poller via /api/prepare/games/bulk-ingest.
        if (signedIn) {
          void uploadGamesToCorpus(platform, handle, setCorpusSync, ac.signal);
        }
        return;
      }

      setProgress({
        phase: 'fetching',
        fetchedGames: 0,
        estimatedTotal: null,
        currentLabel: ranges[0]?.label ?? null,
        errorMessage: null,
      });

      // Only the profile-total estimate is useful for a full cold fetch.
      // Incremental ranges don't have a cheap "since X" count from Lichess,
      // so we leave the bar pulsing without a percentage in that case.
      const isFullFresh = mode === 'fresh' && store.games.size === 0 && ranges.length === 1;
      if (platform === 'lichess' && isFullFresh) {
        const estimated = await lichessProfileGameCount(handle, filters.timeClasses, ac.signal);
        if (estimated !== null) setProgress((p) => ({ ...p, estimatedTotal: estimated }));
      }

      let fetched = 0;
      try {
        for (const range of ranges) {
          if (ac.signal.aborted) return;
          setProgress((p) => ({ ...p, currentLabel: range.label }));

          if (platform === 'lichess') {
            for await (const raw of fetchLichessGames({
              handle,
              since: range.since,
              until: range.until,
              signal: ac.signal,
            })) {
              const game = await parseGameOffThread({
                pgn: raw.pgn,
                targetHandle: handle,
                fallbackId: raw.id,
                playedAt: raw.playedAt,
                timeClass: raw.timeClass,
              });
              if (game) {
                if (ingestGame(platform, handle, game)) {
                  fetched += 1;
                  setProgress((p) => ({ ...p, fetchedGames: fetched }));
                  triggerRebuild(false);
                }
              }
            }
          } else {
            for await (const raw of fetchChesscomGames({
              handle,
              since: range.since,
              until: range.until,
              timeClasses: filters.timeClasses,
              signal: ac.signal,
              onArchiveStart: ({ index, total, label }) =>
                setProgress((p) => ({
                  ...p,
                  currentLabel: `Archive ${label} (${index + 1}/${total})`,
                })),
            })) {
              const game = await parseGameOffThread({
                pgn: raw.pgn,
                targetHandle: handle,
                fallbackId: raw.id,
                playedAt: raw.playedAt,
                timeClass: raw.timeClass,
              });
              if (game) {
                if (ingestGame(platform, handle, game)) {
                  fetched += 1;
                  setProgress((p) => ({ ...p, fetchedGames: fetched }));
                  triggerRebuild(false);
                }
              }
            }
          }
        }
        triggerRebuild(true);
        setProgress((p) => ({ ...p, phase: 'done', fetchedGames: fetched, currentLabel: null }));

        // Flush the IDB write queue, refresh the cached-meta display, then
        // ship the games to the server so Personalized Leaks doesn't have
        // to wait on the (slow, job-style) crawler queue.
        void flushStore(platform, handle).then(async () => {
          if (ac.signal.aborted) return;
          const meta = await loadCachedMeta(platform, handle);
          setCachedMeta(meta);
          if (signedIn) {
            void uploadGamesToCorpus(platform, handle, setCorpusSync, ac.signal);
          }
        });
      } catch (e) {
        if (ac.signal.aborted) return;
        setProgress((p) => ({
          ...p,
          phase: 'error',
          errorMessage: e instanceof Error ? e.message : 'Fetch failed',
        }));
      }
    },
    [filters, platform, handle, triggerRebuild, signedIn],
  );

  const startFetchRef = useRef(startFetch);
  useEffect(() => {
    startFetchRef.current = startFetch;
  }, [startFetch]);

  // Hydrate from BOTH sources in parallel on (re-)mount:
  //   1. IndexedDB — fast, per-browser, has whatever this user fetched before
  //   2. Games corpus via /api/prepare/games — covers cold visitors and fills
  //      in everything the worker pipeline has already crawled
  // After both settle, the live-fetch loop pulls only the delta (forward gap
  // from the latest cached game). We also fire /api/prepare/enqueue to bump
  // crawl priority so the worker pipeline catches up on the back-end.
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    setSanPath([]);
    setCursor(0);
    setCachedMeta(null);
    setProgress({
      phase: 'hydrating',
      fetchedGames: 0,
      estimatedTotal: null,
      currentLabel: 'Loading cached games…',
      errorMessage: null,
    });
    // Fire-and-forget priority bump for signed-in users. It doesn't gate
    // render, and errors are swallowed by the helper.
    if (signedIn) void bumpCorpusPriority(platform, handle, ac.signal);
    void (async () => {
      const [idbResult, corpusResult] = await Promise.all([
        hydrateStore(platform, handle),
        hydrateFromCorpus(platform, handle, ac.signal),
      ]);
      if (cancelled) return;
      if (idbResult.meta) setCachedMeta(idbResult.meta);
      triggerRebuild(true);
      const total = idbResult.loaded + corpusResult.loaded;
      if (total > 0) {
        // Cached games exist (from IDB or corpus) — auto-refresh to pull the
        // delta of anything posted to the platform since our latest cached game.
        void startFetchRef.current('fresh');
      } else {
        setProgress({
          phase: 'idle',
          fetchedGames: 0,
          estimatedTotal: null,
          currentLabel: null,
          errorMessage: null,
        });
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
      abortRef.current?.abort();
    };
    // triggerRebuild is stable (no deps); startFetchRef is a ref so we
    // intentionally don't list either as a dep — we only want this to
    // run on (platform, handle) changes, not on every filter tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, handle]);

  const onFiltersChange = useCallback(
    (next: Filters) => {
      const prev = filters;
      setFilters(next);
      const isFetching = progress.phase === 'fetching' || progress.phase === 'hydrating';
      if (isFetching) return;
      const store = getStore(platform, handle);
      const now = new Date();
      const prevSince = windowBounds(prev, now).since;
      const nextSince = windowBounds(next, now).since;
      const needsExtend =
        nextSince < prevSince &&
        store.earliest !== null &&
        nextSince < store.earliest &&
        store.games.size > 0;
      if (needsExtend) {
        const cutoffEdge = store.earliest ?? now;
        void startFetch('extend', nextSince < cutoffEdge ? nextSince : cutoffEdge);
      }
    },
    [filters, platform, handle, progress.phase, startFetch],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      terminateParseWorker();
    };
  }, []);

  const applyMove = useCallback(
    (fromSquare: string, toSquare: string): boolean => {
      const probe = new Chess(walkerFen);
      let moveObj;
      try {
        moveObj = probe.move({ from: fromSquare, to: toSquare, promotion: 'q' });
      } catch {
        return false;
      }
      if (!moveObj) return false;
      const san = moveObj.san;
      // If we're partway through the line and the picked move matches what
      // comes next, just step forward — preserves the rest of the history so
      // the user can keep walking past the cursor.
      if (cursor < sanPath.length && sanPath[cursor] === san) {
        setCursor(cursor + 1);
        return true;
      }
      // Otherwise the move diverges: drop the now-orphaned tail and append.
      setSanPath((p) => [...p.slice(0, cursor), san]);
      setCursor(cursor + 1);
      return true;
    },
    [walkerFen, cursor, sanPath],
  );

  const handlePickMove = useCallback(
    (move: NextMoveStats) => {
      applyMove(move.fromSquare, move.toSquare);
    },
    [applyMove],
  );

  const handlePieceDrop = useCallback(
    (sourceSquare: string, targetSquare: string): boolean => {
      return applyMove(sourceSquare, targetSquare);
    },
    [applyMove],
  );

  const handleJump = useCallback(
    (ply: number) => {
      if (ply < 0 || ply > sanPath.length) return;
      setCursor(ply);
    },
    [sanPath.length],
  );

  // Arrow keys step the cursor through the move list; Home/End jump to the
  // ends. Skip while focus is in a text input so users can still type freely.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCursor((c) => Math.min(sanPath.length, c + 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCursor(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setCursor(sanPath.length);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sanPath.length]);

  const lastMove = useMemo(() => {
    if (cursor === 0) return null;
    const w = new Chess();
    try {
      for (let i = 0; i < cursor - 1; i += 1) {
        const san = sanPath[i];
        if (san === undefined) return null;
        w.move(san);
      }
      const lastSan = sanPath[cursor - 1];
      if (lastSan === undefined) return null;
      const result = w.move(lastSan);
      return result ? { from: result.from, to: result.to } : null;
    } catch {
      return null;
    }
  }, [sanPath, cursor]);

  const canBuild =
    progress.phase === 'idle' || progress.phase === 'done' || progress.phase === 'error';

  const cachedGameCount = useMemo(
    () => getStore(platform, handle).games.size,
    // rebuildTick forces re-read of the module-level store; see `games` memo above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [platform, handle, rebuildTick],
  );
  const hasData = progress.fetchedGames > 0 || cachedGameCount > 0;
  const hasCache = cachedGameCount > 0;
  const buttonLabel = hasCache ? 'Refresh' : 'Build opening tree';

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">Opening tree</h2>
        <p className="text-[11px] uppercase tracking-[0.15em] text-accent">recency-weighted</p>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Pulls {handle}&rsquo;s games from {platformLabel} on demand. Move strength weights recent
        games higher (1.5y half-life), so the tree reflects their current repertoire — not their
        all-time average. Average centipawn loss per node arrives with the W6 corpus.
      </p>

      <div className="mt-5 space-y-4">
        <TreeFilters
          filters={filters}
          onChange={onFiltersChange}
          disabled={progress.phase === 'fetching'}
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setSanPath([]);
              setCursor(0);
              void startFetch('fresh');
            }}
            disabled={!canBuild}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {buttonLabel}
          </button>
          {progress.phase === 'fetching' ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
            >
              Cancel
            </button>
          ) : null}
          {hasCache && cachedMeta ? (
            <span className="text-xs text-muted-foreground">
              Cached: {cachedGameCount.toLocaleString()} games · last refreshed{' '}
              {formatTimeAgo(cachedMeta.updatedAt, new Date())}
            </span>
          ) : null}
        </div>

        <FetchProgressBar progress={progress} filteredGameCount={filteredGameCount} />

        {corpusSync !== 'idle' && corpusSync !== 'skipped' ? (
          <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
            {corpusSync === 'uploading' ? 'Syncing recent games to corpus…' : null}
            {corpusSync === 'ready' ? 'Games synced to corpus' : null}
            {corpusSync === 'failed' ? 'Sync to corpus failed — leaks may be slower' : null}
          </p>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-3">
            <BreadcrumbPath sanPath={sanPath} cursor={cursor} onJump={handleJump} />
            <OpeningTreeBoard
              fen={walkerFen}
              orientation={filters.color}
              topMoves={topMoves}
              hoveredMove={hoveredMove}
              lastMove={lastMove}
              onPickMove={handlePickMove}
              onPieceDrop={handlePieceDrop}
            />
          </div>
          <div>
            {hasData ? (
              <MoveListPanel
                platform={platform}
                handle={handle}
                node={currentNode}
                totalGamesAtNode={currentNode?.totalGames ?? 0}
                onPickMove={handlePickMove}
                onHoverMove={setHoveredMove}
                samplesForMove={samplesForMove}
              />
            ) : (
              <div className="rounded-md border border-dashed border-border bg-card px-4 py-8 text-center text-xs text-muted-foreground">
                Click <span className="font-semibold text-accent">Build opening tree</span> to load
                games and see {handle}&rsquo;s most-played moves at each position.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Ship the browser's cached games to the games corpus. Fire-and-forget —
 * called after the OpeningTree fetch loop completes. Skipping the upload
 * is safe; PersonalizedLeaks will fall back to the existing crawler queue
 * (which can take much longer).
 */
async function uploadGamesToCorpus(
  platform: Platform,
  handle: string,
  setStatus: (s: CorpusSyncStatus) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  setStatus('uploading');
  try {
    const cached = await loadCachedGames(platform, handle);
    if (cached.length === 0) {
      setStatus('idle');
      return;
    }
    // Most-recent-first so the 500-cap keeps the freshest games when we
    // hit the limit, which is what the leaks scorer cares about.
    cached.sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime());
    const slice: GameRecord[] = [];
    let plyCount = 0;
    for (const game of cached) {
      if (slice.length >= CORPUS_SYNC_GAME_CAP) break;
      const nextPlyCount = plyCount + game.movesUci.length;
      if (nextPlyCount > CORPUS_SYNC_PLY_CAP) continue;
      slice.push(game);
      plyCount = nextPlyCount;
    }
    if (slice.length === 0) {
      setStatus('idle');
      return;
    }
    const res = await fetch('/api/prepare/games/bulk-ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, handle, games: slice }),
      signal,
    });
    if (signal.aborted) return;
    if (!res.ok) {
      setStatus('failed');
      return;
    }
    setStatus('ready');
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[opening-tree] corpus sync failed', err);
    setStatus('failed');
  }
}
