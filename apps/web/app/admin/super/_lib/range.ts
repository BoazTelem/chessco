export type Range = '7d' | '30d' | '90d' | 'all';

export const RANGES: { key: Range; label: string; days: number | null }[] = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: 'all', label: 'All time', days: null },
];

export function parseRange(value: string | string[] | undefined): Range {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === '7d' || v === '30d' || v === '90d' || v === 'all') return v;
  return '30d';
}

export function rangeStartISO(range: Range): string | null {
  const cfg = RANGES.find((r) => r.key === range);
  if (!cfg || cfg.days === null) return null;
  const start = new Date(Date.now() - cfg.days * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

export function rangeLabel(range: Range): string {
  return RANGES.find((r) => r.key === range)?.label ?? 'Last 30 days';
}
