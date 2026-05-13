'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export type TrendSeries = {
  key: string;
  label: string;
  color: string;
};

export type TrendPoint = Record<string, string | number> & { date: string };

export type ValueFormat = 'count' | 'cents';

const FORMATTERS: Record<ValueFormat, (v: number) => string> = {
  count: (v) => new Intl.NumberFormat('en-US').format(v),
  cents: (v) => `$${(v / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
};

export function TrendChart({
  data,
  series,
  valueFormat = 'count',
  height = 240,
}: {
  data: TrendPoint[];
  series: TrendSeries[];
  valueFormat?: ValueFormat;
  height?: number;
}) {
  const yFormatter = FORMATTERS[valueFormat];
  if (!data.length) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded border border-dashed border-border text-sm text-muted-foreground">
        No data in this range yet.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.5} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="date"
          tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
        />
        <YAxis
          tickFormatter={yFormatter}
          tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
          width={56}
        />
        <Tooltip
          contentStyle={{
            background: '#0F172A',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(v) => yFormatter(Number(v))}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            fill={`url(#g-${s.key})`}
            strokeWidth={2}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
