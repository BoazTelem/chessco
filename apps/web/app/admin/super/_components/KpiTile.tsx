export function KpiTile({
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'default' | 'positive' | 'warning' | 'danger';
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-emerald-400'
      : tone === 'warning'
        ? 'text-amber-400'
        : tone === 'danger'
          ? 'text-rose-400'
          : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <p className={`mt-2 font-display text-3xl font-bold tracking-tight ${toneClass}`}>{value}</p>
      {sublabel && <p className="mt-1 text-xs text-muted-foreground">{sublabel}</p>}
    </div>
  );
}
