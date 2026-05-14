import { SegmentedLinks } from '@/components/ui/SegmentedControl';
import { RANGES, type Range } from '../_lib/range';

export function RangeSelector({ current, basePath }: { current: Range; basePath: string }) {
  return (
    <SegmentedLinks<Range>
      options={RANGES.map((r) => ({
        value: r.key,
        label: r.label,
        href: `${basePath}?range=${r.key}`,
      }))}
      value={current}
      ariaLabel="Time range"
    />
  );
}
