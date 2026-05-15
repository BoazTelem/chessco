/**
 * GET-form filters for /admin/super/searches. Each field maps 1:1 to a
 * query-string parameter consumed by page.tsx. Submits via a standard
 * <form> so the URL stays bookmarkable and pagination preserves filters.
 */
const KINDS = [
  { value: '', label: 'All kinds' },
  { value: 'scout_query', label: 'Scout query' },
  { value: 'prepare_verify', label: 'Prepare verify' },
  { value: 'prep_visit', label: 'Prep visit' },
  { value: 'leak_reveal', label: 'Leak reveal' },
] as const;

const IDENTITIES = [
  { value: '', label: 'Any' },
  { value: 'signed_in', label: 'Signed in' },
  { value: 'anon', label: 'Anonymous' },
] as const;

interface Props {
  q: string;
  kind: string;
  identity: string;
  profile: string;
  country: string;
  session: string;
  from: string;
  to: string;
}

export function FiltersBar({ q, kind, identity, profile, country, session, from, to }: Props) {
  return (
    <form className="grid gap-2 md:grid-cols-4" action="/admin/super/searches">
      <input
        name="q"
        defaultValue={q}
        placeholder="Query or target handle…"
        className="rounded-md border border-border bg-background px-3 py-2 text-sm md:col-span-2"
      />
      <select
        name="kind"
        defaultValue={kind}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm"
      >
        {KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      <select
        name="identity"
        defaultValue={identity}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm"
      >
        {IDENTITIES.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </select>

      <input
        name="profile"
        defaultValue={profile}
        placeholder="Email contains…"
        className="rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <input
        name="country"
        defaultValue={country}
        placeholder="Country (ISO-2)"
        maxLength={2}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm uppercase"
      />
      <input
        name="session"
        defaultValue={session}
        placeholder="Session id (UUID)"
        className="rounded-md border border-border bg-background px-3 py-2 text-sm md:col-span-2 font-mono text-xs"
      />

      <input
        type="date"
        name="from"
        defaultValue={from}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <input
        type="date"
        name="to"
        defaultValue={to}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <div className="md:col-span-2 flex gap-2">
        <button
          type="submit"
          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted"
        >
          Apply filters
        </button>
        <a
          href="/admin/super/searches"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-muted"
        >
          Clear
        </a>
      </div>
    </form>
  );
}
