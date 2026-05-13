'use client';

import { useState } from 'react';
import type { GameRecord, NextMoveStats, Platform, TreeNode } from '@/lib/prepare/types';
import { recencyTrend, simplifyCount } from '@/lib/prepare/format';
import { ResultsTable } from './ResultsTable';

interface Props {
  platform: Platform;
  handle: string;
  node: TreeNode | null;
  totalGamesAtNode: number;
  onPickMove: (move: NextMoveStats) => void;
  onHoverMove: (move: NextMoveStats | null) => void;
  samplesForMove: (move: NextMoveStats) => GameRecord[];
}

type SortMode = 'weighted' | 'raw';

const MIN_GAMES_FOR_WIN_PCT = 3;

function winPct(stats: NextMoveStats): number | null {
  const total = stats.gamesCount;
  if (total < MIN_GAMES_FOR_WIN_PCT) return null;
  return Math.round(((stats.wins + 0.5 * stats.draws) / total) * 100);
}

export function MoveListPanel({
  platform,
  handle,
  node,
  totalGamesAtNode,
  onPickMove,
  onHoverMove,
  samplesForMove,
}: Props) {
  const [sort, setSort] = useState<SortMode>('weighted');
  const [showAll, setShowAll] = useState(false);
  const [expandedUci, setExpandedUci] = useState<string | null>(null);

  if (!node || node.children.size === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground">
        No games reached this position yet.
      </div>
    );
  }

  const moves = [...node.children.values()].sort((a, b) =>
    sort === 'weighted' ? b.weightedScore - a.weightedScore : b.gamesCount - a.gamesCount,
  );
  const topWeighted = moves.reduce((m, x) => Math.max(m, x.weightedScore), 0);
  const visible = showAll ? moves : moves.slice(0, 12);

  return (
    <div className="space-y-3" onMouseLeave={() => onHoverMove(null)}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="text-muted-foreground">
          {simplifyCount(totalGamesAtNode)} games · {moves.length} replies
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
          <button
            type="button"
            onClick={() => setSort('weighted')}
            className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wider transition ${
              sort === 'weighted'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            recency
          </button>
          <button
            type="button"
            onClick={() => setSort('raw')}
            className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wider transition ${
              sort === 'raw'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            raw
          </button>
        </div>
      </div>

      <ul className="divide-y divide-border rounded-md border border-border bg-card">
        {visible.map((m) => {
          const wp = winPct(m);
          const weightedPct = topWeighted > 0 ? (m.weightedScore / topWeighted) * 100 : 0;
          const trend = recencyTrend(
            m.weightedScore,
            m.gamesCount,
            node.totalWeighted,
            node.totalGames,
          );
          const isExpanded = expandedUci === m.uci;
          return (
            <li key={m.uci} onMouseEnter={() => onHoverMove(m)}>
              <div className="grid w-full grid-cols-[3.5rem_auto_1fr_3rem_3.5rem_1.5rem] items-center gap-2 px-3 py-2 text-xs">
                <button
                  type="button"
                  onClick={() => onPickMove(m)}
                  className="text-left font-mono text-sm font-semibold text-foreground hover:text-accent"
                  title={`Play ${m.san}`}
                >
                  {m.san}
                </button>
                <span
                  className="inline-flex h-4 w-7 items-center justify-center rounded-full text-[10px] font-bold"
                  title={
                    trend.kind === 'neutral'
                      ? 'Played at this position’s baseline rate'
                      : `Played ${trend.ratio.toFixed(2)}× the node’s recency baseline`
                  }
                  style={
                    trend.kind === 'trending'
                      ? { background: 'hsla(145, 70%, 35%, 0.2)', color: 'hsl(145, 70%, 55%)' }
                      : trend.kind === 'fading'
                        ? { background: 'hsla(35, 80%, 35%, 0.2)', color: 'hsl(35, 90%, 60%)' }
                        : { background: 'transparent', color: 'transparent' }
                  }
                >
                  {trend.kind === 'trending' ? '↗' : trend.kind === 'fading' ? '↘' : ' '}
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-1.5 flex-1 rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${weightedPct}%` }}
                    />
                  </span>
                </span>
                <span className="text-right font-mono text-muted-foreground">
                  {simplifyCount(m.gamesCount)}
                </span>
                <span
                  className={`text-right font-mono ${
                    wp === null
                      ? 'text-muted-foreground/50'
                      : wp >= 55
                        ? 'text-emerald-400'
                        : wp <= 45
                          ? 'text-rose-400'
                          : 'text-foreground'
                  }`}
                  title={
                    wp === null
                      ? `Sample too small for a meaningful win rate (${m.gamesCount} game${m.gamesCount === 1 ? '' : 's'})`
                      : undefined
                  }
                >
                  {wp === null ? '—' : `${wp}%`}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedUci(isExpanded ? null : m.uci);
                  }}
                  className="text-muted-foreground hover:text-accent"
                  aria-label={isExpanded ? 'Collapse sample games' : 'Show sample games'}
                  title={isExpanded ? 'Collapse sample games' : 'Show sample games'}
                >
                  {isExpanded ? '▾' : '▸'}
                </button>
              </div>
              {isExpanded ? (
                <div className="px-3 pb-3">
                  <ResultsTable
                    platform={platform}
                    games={samplesForMove(m)}
                    targetHandle={handle}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {moves.length > 12 ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-accent hover:underline"
        >
          {showAll ? 'Show top 12' : `Show all ${moves.length}`}
        </button>
      ) : null}
    </div>
  );
}
