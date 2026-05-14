'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

interface SegmentedOption<V extends string | number> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

interface CommonProps {
  equalWidth?: boolean;
  /** When true, the bar stretches to fill the parent. Default false (sized to content). */
  fullWidth?: boolean;
  className?: string;
}

interface SegmentedControlProps<V extends string | number> extends CommonProps {
  options: SegmentedOption<V>[];
  value: V;
  onChange: (next: V) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

function containerClass(fullWidth: boolean): string {
  return [
    'inline-flex flex-wrap gap-1 rounded-md border border-border bg-background p-1 text-xs',
    fullWidth ? 'w-full' : 'w-fit',
  ].join(' ');
}

function segmentClass(active: boolean, equalWidth: boolean): string {
  return [
    'rounded px-2.5 py-1 transition disabled:cursor-not-allowed disabled:opacity-50',
    equalWidth ? 'flex-1 text-center' : '',
    active
      ? 'bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  ]
    .filter(Boolean)
    .join(' ');
}

export function SegmentedControl<V extends string | number>({
  options,
  value,
  onChange,
  disabled,
  equalWidth = false,
  fullWidth = false,
  className = '',
  ariaLabel,
}: SegmentedControlProps<V>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`${containerClass(fullWidth)} ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || opt.disabled}
            onClick={() => onChange(opt.value)}
            className={segmentClass(active, equalWidth)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface MultiSegmentedControlProps<V extends string | number> extends CommonProps {
  options: SegmentedOption<V>[];
  values: ReadonlySet<V> | readonly V[];
  onToggle: (value: V) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function MultiSegmentedControl<V extends string | number>({
  options,
  values,
  onToggle,
  disabled,
  equalWidth = false,
  fullWidth = false,
  className = '',
  ariaLabel,
}: MultiSegmentedControlProps<V>) {
  const isActive = (v: V) =>
    values instanceof Set ? values.has(v) : (values as readonly V[]).includes(v);
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`${containerClass(fullWidth)} ${className}`}
    >
      {options.map((opt) => {
        const active = isActive(opt.value);
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="checkbox"
            aria-checked={active}
            disabled={disabled || opt.disabled}
            onClick={() => onToggle(opt.value)}
            className={segmentClass(active, equalWidth)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface SegmentedLinkOption<V extends string | number> extends SegmentedOption<V> {
  href: string;
}

interface SegmentedLinksProps<V extends string | number> extends CommonProps {
  options: SegmentedLinkOption<V>[];
  value: V;
  ariaLabel?: string;
}

export function SegmentedLinks<V extends string | number>({
  options,
  value,
  equalWidth = false,
  fullWidth = false,
  className = '',
  ariaLabel,
}: SegmentedLinksProps<V>) {
  return (
    <nav aria-label={ariaLabel} className={`${containerClass(fullWidth)} ${className}`}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Link
            key={String(opt.value)}
            href={opt.href}
            aria-current={active ? 'page' : undefined}
            className={segmentClass(active, equalWidth)}
          >
            {opt.label}
          </Link>
        );
      })}
    </nav>
  );
}
