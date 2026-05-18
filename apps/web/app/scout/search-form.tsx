'use client';

import { useId, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { COUNTRIES } from '@/lib/scout/countries';
import { type FederationOption, groupFederationsByContinent } from '@/lib/scout/federations-shared';

type Initial = {
  q: string;
  country: string;
  title: string;
  min: string;
  max: string;
  federation: string;
};

const TITLES: { code: string; label: string }[] = [
  { code: '', label: 'Any title' },
  { code: 'GM', label: 'GM' },
  { code: 'WGM', label: 'WGM' },
  { code: 'IM', label: 'IM' },
  { code: 'WIM', label: 'WIM' },
  { code: 'FM', label: 'FM' },
  { code: 'WFM', label: 'WFM' },
  { code: 'CM', label: 'CM' },
  { code: 'WCM', label: 'WCM' },
];

export function SearchForm({
  federations,
  initial,
}: {
  federations: FederationOption[];
  initial: Initial;
}) {
  const id = useId();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const hasAdvanced =
    initial.title.length > 0 ||
    initial.min.length > 0 ||
    initial.max.length > 0 ||
    initial.federation.length > 0;

  const groups = groupFederationsByContinent(federations);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string' && v.trim().length > 0) params.set(k, v.trim());
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `/scout?${qs}` : '/scout');
    });
  }

  return (
    <form method="GET" action="/scout" onSubmit={onSubmit} className="space-y-4">
      {/* Primary: country flag + name */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <select
          name="country"
          defaultValue={initial.country}
          aria-label="Country"
          className="rounded-md border border-border bg-background px-2 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">🌐 Any</option>
          {COUNTRIES.map((c) => (
            <option key={c.code3} value={c.code3}>
              {c.flag} {c.name}
            </option>
          ))}
        </select>

        <input
          name="q"
          type="search"
          autoFocus
          defaultValue={initial.q}
          placeholder="Name, e.g. carlsen, gelfand, your friend's name"
          className="block w-full rounded-md border border-border bg-background px-3 py-2 text-base placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />

        <button
          type="submit"
          disabled={isPending}
          aria-busy={isPending}
          className="inline-flex min-w-[5.5rem] items-center justify-center gap-2 rounded-md bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-75"
        >
          {isPending ? (
            <>
              <span
                aria-hidden
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
              />
              <span>Searching…</span>
            </>
          ) : (
            'Search'
          )}
        </button>
      </div>

      {/* Advanced: title / rating range */}
      <details
        open={hasAdvanced}
        className="rounded-md border border-border/60 bg-card/40 px-4 py-3"
      >
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Advanced filters
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Federation" htmlFor={`${id}-fed`}>
            <select
              id={`${id}-fed`}
              name="federation"
              defaultValue={initial.federation}
              className={selectClass}
            >
              <option value="">All federations</option>
              {groups.map((group) => (
                <optgroup key={group.continent} label={group.label}>
                  {group.items.map((f) => (
                    <option key={f.code} value={f.code}>
                      {f.code}: {f.name}
                      {f.active ? '' : ' · FIDE-only'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          <Field label="Title" htmlFor={`${id}-title`}>
            <select
              id={`${id}-title`}
              name="title"
              defaultValue={initial.title}
              className={selectClass}
            >
              {TITLES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Min rating" htmlFor={`${id}-min`}>
            <input
              id={`${id}-min`}
              name="min"
              type="number"
              min={0}
              max={3000}
              step={50}
              defaultValue={initial.min}
              placeholder="1500"
              className={inputClass}
            />
          </Field>

          <Field label="Max rating" htmlFor={`${id}-max`}>
            <input
              id={`${id}-max`}
              name="max"
              type="number"
              min={0}
              max={3000}
              step={50}
              defaultValue={initial.max}
              placeholder="2900"
              className={inputClass}
            />
          </Field>
        </div>
      </details>
    </form>
  );
}

const inputClass =
  'block w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const selectClass = inputClass;

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
