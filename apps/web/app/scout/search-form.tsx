'use client';

import { useId } from 'react';

type Initial = {
  q: string;
  country: string;
  fed: string;
  title: string;
  min: string;
  max: string;
};

const COMMON_COUNTRIES: { code: string; label: string }[] = [
  { code: '', label: 'Any country' },
  { code: 'ISR', label: 'Israel (ISR)' },
  { code: 'USA', label: 'United States (USA)' },
  { code: 'GBR', label: 'England (GBR)' },
  { code: 'GER', label: 'Germany (GER)' },
  { code: 'FRA', label: 'France (FRA)' },
  { code: 'ESP', label: 'Spain (ESP)' },
  { code: 'ITA', label: 'Italy (ITA)' },
  { code: 'NOR', label: 'Norway (NOR)' },
  { code: 'NED', label: 'Netherlands (NED)' },
  { code: 'POL', label: 'Poland (POL)' },
  { code: 'IND', label: 'India (IND)' },
  { code: 'CHN', label: 'China (CHN)' },
  { code: 'RUS', label: 'Russia (RUS)' },
  { code: 'UKR', label: 'Ukraine (UKR)' },
  { code: 'ARM', label: 'Armenia (ARM)' },
  { code: 'AZE', label: 'Azerbaijan (AZE)' },
  { code: 'GEO', label: 'Georgia (GEO)' },
  { code: 'CAN', label: 'Canada (CAN)' },
  { code: 'AUS', label: 'Australia (AUS)' },
  { code: 'BRA', label: 'Brazil (BRA)' },
  { code: 'ARG', label: 'Argentina (ARG)' },
];

const TITLES: { code: string; label: string }[] = [
  { code: '', label: 'Any title' },
  { code: 'GM', label: 'Grandmaster (GM)' },
  { code: 'WGM', label: 'Women GM (WGM)' },
  { code: 'IM', label: 'Int. Master (IM)' },
  { code: 'WIM', label: 'Women IM (WIM)' },
  { code: 'FM', label: 'FIDE Master (FM)' },
  { code: 'WFM', label: 'Women FM (WFM)' },
  { code: 'CM', label: 'Candidate Master (CM)' },
  { code: 'WCM', label: 'Women CM (WCM)' },
];

export function SearchForm({ initial }: { initial: Initial }) {
  const id = useId();

  return (
    <form method="GET" action="/scout" className="space-y-4">
      <div>
        <input
          name="q"
          type="search"
          autoFocus
          defaultValue={initial.q}
          placeholder="Search by name — e.g. magnus carlsen, kasparov, telem"
          className="block w-full rounded-lg border border-border bg-background px-4 py-3 text-base placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Country" htmlFor={`${id}-country`}>
          <select
            id={`${id}-country`}
            name="country"
            defaultValue={initial.country}
            className={selectClass}
          >
            {COMMON_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
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
            placeholder="e.g. 2000"
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
            placeholder="e.g. 2400"
            className={inputClass}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Trigram fuzzy match — typos and partial names work. Country codes are 3-letter FIDE (NOR,
          USA, ISR…).
        </p>
        <button
          type="submit"
          className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
        >
          Search
        </button>
      </div>
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
