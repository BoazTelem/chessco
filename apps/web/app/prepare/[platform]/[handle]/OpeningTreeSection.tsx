'use client';

import { Chess } from 'chess.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OpeningTreeBoard } from '@/components/prepare/OpeningTreeBoard';
import { BreadcrumbPath } from '@/components/prepare/BreadcrumbPath';
import { FetchProgressBar } from '@/components/prepare/FetchProgressBar';
import { MoveListPanel } from '@/components/prepare/MoveListPanel';
import { TreeFilters } from '@/components/prepare/TreeFilters';
import { fetchChesscomGames } from '@/lib/prepare/fetch-chesscom';
import { fetchLichessGames, lichessProfileGameCount } from '@/lib/prepare/fetch-lichess';
import { normalizeFenKey } from '@/lib/prepare/parse-pgn';
import { parseGameOffThread, terminateParseWorker } from '@/lib/prepare/parse-worker-client';
import { buildTree, gamePassesFilters, windowBounds } from '@/lib/prepare/tree-builder';
import { getStore, ingestGame, listGames } from '@/lib/prepare/storage';
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
}

export function OpeningTreeSection({ platform, handle }: Props) {
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
  const [hoveredMove, setHoveredMove] = useState<NextMoveStats | null>(null);
  const walkerRef = useRef<Chess>(new Chess());
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

  const currentFenKey = useMemo(() => normalizeFenKey(walkerRef.current.fen()), [sanPath]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const since = extendFrom ?? bounds.since;
      const until = bounds.until;

      setProgress({
        phase: 'fetching',
        fetchedGames: 0,
        estimatedTotal: null,
        currentLabel: mode === 'extend' ? 'Extending window…' : null,
        errorMessage: null,
      });

      let estimated: number | null = null;
      if (platform === 'lichess') {
        estimated = await lichessProfileGameCount(handle, filters.timeClasses, ac.signal);
        if (estimated !== null) setProgress((p) => ({ ...p, estimatedTotal: estimated }));
      }

      let fetched = 0;
      try {
        if (platform === 'lichess') {
          for await (const raw of fetchLichessGames({
            handle,
            since,
            until,
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
            since,
            until,
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
        triggerRebuild(true);
        setProgress((p) => ({ ...p, phase: 'done', fetchedGames: fetched, currentLabel: null }));
      } catch (e) {
        if (ac.signal.aborted) return;
        setProgress((p) => ({
          ...p,
          phase: 'error',
          errorMessage: e instanceof Error ? e.message : 'Fetch failed',
        }));
      }
    },
    [filters, platform, handle, triggerRebuild],
  );

  const onFiltersChange = useCallback(
    (next: Filters) => {
      const prev = filters;
      setFilters(next);
      const isFetching = progress.phase === 'fetching';
      if (isFetching) return;
      const store = getStore(platform, handle);
      const now = new Date();
      const prevSince = windowBounds(prev, now).since;
      const nextSince = windowBounds(next, now).since;
      const needsExtend =
        nextSince < prevSince &&
        store.earliest !== null &&
        nextSince < store.earliest &&
        progress.fetchedGames > 0;
      if (needsExtend) {
        const cutoffEdge = store.earliest ?? now;
        void startFetch('extend', nextSince < cutoffEdge ? nextSince : cutoffEdge);
      }
    },
    [filters, platform, handle, progress.fetchedGames, progress.phase, startFetch],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      terminateParseWorker();
    };
  }, []);

  const handlePickMove = useCallback((move: NextMoveStats) => {
    const w = walkerRef.current;
    let moveObj;
    try {
      moveObj = w.move({ from: move.fromSquare, to: move.toSquare, promotion: 'q' });
    } catch {
      return;
    }
    if (!moveObj) return;
    setSanPath((p) => [...p, moveObj.san]);
  }, []);

  const handlePieceDrop = useCallback((sourceSquare: string, targetSquare: string): boolean => {
    const w = walkerRef.current;
    let moveObj;
    try {
      moveObj = w.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
    } catch {
      return false;
    }
    if (!moveObj) return false;
    setSanPath((p) => [...p, moveObj.san]);
    return true;
  }, []);

  const handleJump = useCallback(
    (ply: number) => {
      if (ply > sanPath.length) return;
      const w = new Chess();
      const newPath = sanPath.slice(0, ply);
      for (const san of newPath) {
        try {
          w.move(san);
        } catch {
          return;
        }
      }
      walkerRef.current = w;
      setSanPath(newPath);
    },
    [sanPath],
  );

  const lastMove = useMemo(() => {
    if (sanPath.length === 0) return null;
    const w = new Chess();
    try {
      for (let i = 0; i < sanPath.length - 1; i += 1) {
        const san = sanPath[i];
        if (san === undefined) return null;
        w.move(san);
      }
      const lastSan = sanPath[sanPath.length - 1];
      if (lastSan === undefined) return null;
      const result = w.move(lastSan);
      return result ? { from: result.from, to: result.to } : null;
    } catch {
      return null;
    }
  }, [sanPath]);

  const canBuild =
    progress.phase === 'idle' || progress.phase === 'done' || progress.phase === 'error';

  const hasData = progress.fetchedGames > 0;

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
              walkerRef.current = new Chess();
              setSanPath([]);
              void startFetch('fresh');
            }}
            disabled={!canBuild}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {progress.phase === 'done' ? 'Re-fetch' : 'Build opening tree'}
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
        </div>

        <FetchProgressBar progress={progress} filteredGameCount={filteredGameCount} />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-3">
            <BreadcrumbPath sanPath={sanPath} onJump={handleJump} />
            <OpeningTreeBoard
              fen={walkerRef.current.fen()}
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
