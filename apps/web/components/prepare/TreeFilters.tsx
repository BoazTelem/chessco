'use client';

import type { Color, Filters, RealTimeClass, WindowPreset } from '@/lib/prepare/types';
import { REAL_TIME_CLASSES } from '@/lib/prepare/types';

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  disabled?: boolean;
}

const TIME_CLASS_LABELS: Record<RealTimeClass, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
};

const WINDOW_OPTIONS: { value: WindowPreset; label: string }[] = [
  { value: 1, label: 'Last 1y' },
  { value: 2, label: 'Last 2y' },
  { value: 3, label: 'Last 3y' },
  { value: 5, label: 'Last 5y' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

function toggleChipClass(active: boolean): string {
  const base =
    'rounded-md border px-2.5 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-50';
  if (active) return `${base} border-accent bg-accent text-accent-foreground`;
  return `${base} border-border bg-card text-foreground hover:border-accent/60`;
}

function dateInputValue(d: Date | null): string {
  if (!d) return '';
  // YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateInput(v: string): Date | null {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function TreeFilters({ filters, onChange, disabled }: Props) {
  const setColor = (color: Color) => onChange({ ...filters, color });
  const toggleTimeClass = (tc: RealTimeClass) => {
    const next = new Set(filters.timeClasses);
    if (next.has(tc)) next.delete(tc);
    else next.add(tc);
    onChange({ ...filters, timeClasses: next });
  };
  const setWindow = (window: WindowPreset) => {
    if (window === 'custom') {
      const now = new Date();
      const defaultSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      onChange({
        ...filters,
        window,
        customSince: filters.customSince ?? defaultSince,
        customUntil: filters.customUntil ?? now,
      });
    } else {
      onChange({ ...filters, window, customSince: null, customUntil: null });
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
      <div className="grid gap-3 lg:grid-cols-[auto_1fr_auto] lg:items-start">
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Color</div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setColor('white')}
              className={toggleChipClass(filters.color === 'white')}
            >
              As White
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setColor('black')}
              className={toggleChipClass(filters.color === 'black')}
            >
              As Black
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            Time class{' '}
            <span className="ml-1 text-muted-foreground/60">
              {filters.timeClasses.size === 0 ? '(none = all)' : `(${filters.timeClasses.size})`}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {REAL_TIME_CLASSES.map((tc) => (
              <button
                key={tc}
                type="button"
                disabled={disabled}
                onClick={() => toggleTimeClass(tc)}
                className={toggleChipClass(filters.timeClasses.has(tc))}
              >
                {TIME_CLASS_LABELS[tc]}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            Window
          </div>
          <div className="flex flex-wrap gap-1">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={String(opt.value)}
                type="button"
                disabled={disabled}
                onClick={() => setWindow(opt.value)}
                className={toggleChipClass(filters.window === opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {filters.window === 'custom' ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="uppercase tracking-[0.15em]">Since</span>
            <input
              type="date"
              value={dateInputValue(filters.customSince)}
              max={dateInputValue(filters.customUntil ?? new Date())}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...filters, customSince: parseDateInput(e.target.value) })
              }
              className="rounded border border-border bg-card px-2 py-1 text-foreground"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="uppercase tracking-[0.15em]">Until</span>
            <input
              type="date"
              value={dateInputValue(filters.customUntil)}
              min={dateInputValue(filters.customSince)}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...filters, customUntil: parseDateInput(e.target.value) })
              }
              className="rounded border border-border bg-card px-2 py-1 text-foreground"
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
