# Setup Checklist — Vercel + Supabase + Observability

Concrete steps to provision Chessco's external services. Complete these in order; later phases depend on them.

**You** (Boaz) do the steps below. **Claude** picks up after to wire credentials into code.

---

## 1. Vercel

### 1a. Create project

1. Go to https://vercel.com and sign in (use the same email as the GitHub account `BoazTelem`)
2. From the dashboard: **Add New… → Project**
3. Select the `BoazTelem/chessco` GitHub repo (authorize Vercel's GitHub app if prompted)
4. **Framework preset:** Next.js (auto-detected)
5. **Root directory:** click _Edit_ → select `apps/web`
6. **Build & output settings:** leave defaults — pnpm + Turborepo handles the rest
7. Don't add env vars yet — we'll do that after Supabase is ready
8. Click **Deploy**. First deploy will succeed and serve the Phase 0 placeholder landing page.

### 1b. Domain

1. **Project Settings → Domains → Add** `chessco.org`
2. Follow the DNS instructions Vercel provides (point apex A/AAAA records to Vercel)
3. Add `www.chessco.org` and redirect www → apex
4. Wildcard `*.chessco.org` is optional (useful for branch previews on a custom subdomain)

### 1c. Capture for later

- **Production URL** (e.g. `chessco.org` once DNS propagates, or `chessco.vercel.app` meanwhile)
- **Preview URL pattern** (e.g. `chessco-<branch>-boaztelem.vercel.app`)

---

## 2. Supabase

### 2a. Two projects

Free tier is fine for both initially. Both should be in the **same region** (start with one closest to your user base — EU Frankfurt for IL/EU launch, or US East if uncertain).

| Name              | Purpose                          | When it's used                                    |
| ----------------- | -------------------------------- | ------------------------------------------------- |
| `chessco-prod`    | Production data                  | Vercel Production deploys (`main` branch)         |
| `chessco-staging` | Staging mirror + preview deploys | Vercel Preview deploys (PRs and feature branches) |

For each:

1. https://supabase.com → New project
2. Set a **strong DB password** and save it in a password manager — Supabase won't show it again
3. Wait ~2 minutes for provisioning

### 2b. Enable Postgres extensions (both projects)

In each project's dashboard → **Database → Extensions**, enable:

- `pgvector` — Phase 2 embedding similarity search
- `pg_trgm` — Phase 0 Week 5 federation name fuzzy search
- `pgcrypto` — enables `gen_random_uuid()` used by every primary key

(`uuid-ossp` is also fine if `pgcrypto` is unavailable for any reason.)

### 2c. Capture credentials (both projects)

For each project: **Project Settings → API**. You'll need three values per project:

| Supabase field              | Env variable name               | Where it goes                                                                                |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| Project URL                 | `NEXT_PUBLIC_SUPABASE_URL`      | Vercel + `apps/web/.env.local` (public, OK in client bundle)                                 |
| `anon` `public` key         | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel + `apps/web/.env.local` (public, OK in client bundle)                                 |
| `service_role` `secret` key | `SUPABASE_SERVICE_ROLE_KEY`     | Vercel **encrypted** + `apps/web/.env.local` only. **NEVER** commit, **NEVER** send in chat. |

⚠️ The `service_role` key bypasses Row-Level Security. Server-side use only. Treat it like a database admin password.

### 2d. Auth configuration (prod and staging)

**Authentication → Providers:**

- **Email** — enable, with magic link enabled
- Google / Apple — defer to Phase 0 Week 3 (needs OAuth credentials from those providers)

**Authentication → URL Configuration:**

- **Site URL:** `https://chessco.org` for prod; `https://chessco-staging.vercel.app` (or whatever your staging URL is) for staging
- **Redirect URLs (add all):**
  - `https://chessco.org/**`
  - `https://*.vercel.app/**` (covers branch previews)
  - `http://localhost:3000/**` (covers local dev)

---

## 3. Wire Vercel ↔ Supabase

In the Vercel project: **Settings → Environment Variables**.

### 3a. Production environment

Add (scope: **Production**):

```
NEXT_PUBLIC_SUPABASE_URL=<chessco-prod URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<chessco-prod anon key>
SUPABASE_SERVICE_ROLE_KEY=<chessco-prod service role key>   (toggle "Sensitive")
NEXT_PUBLIC_APP_URL=https://chessco.org
```

### 3b. Preview environment

Add (scope: **Preview**) using **staging** Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=<chessco-staging URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<chessco-staging anon key>
SUPABASE_SERVICE_ROLE_KEY=<chessco-staging service role key>   (toggle "Sensitive")
NEXT_PUBLIC_APP_URL=https://$VERCEL_URL
```

Trigger a redeploy on `main` after adding these.

---

## 4. Local development

Copy the template and fill in **staging** credentials (never put prod keys on a dev laptop):

```bash
cp apps/web/.env.example apps/web/.env.local
# Edit apps/web/.env.local with staging values from §2c
```

`.env.local` is gitignored.

Verify locally:

```bash
pnpm install         # if you haven't already
pnpm dev             # opens http://localhost:3000
```

---

## 5. Optional now, required before launch

These improve observability and aren't blocking Phase 0 functionality, but should be wired before paid traffic (Phase 4).

### 5a. Sentry

1. Sign up at https://sentry.io (Vercel SSO is convenient)
2. Create a **Next.js** project named `chessco-web`
3. Copy the DSN
4. Add to Vercel env vars (both Production and Preview):
   - `SENTRY_DSN` = the DSN
   - `NEXT_PUBLIC_SENTRY_DSN` = same value
5. The `@sentry/nextjs` SDK gets wired in Phase 0 Week 7 polish

### 5b. PostHog

1. Sign up at https://posthog.com
2. Create project `chessco`
3. Copy the project API key
4. Add to Vercel env vars (both):
   - `NEXT_PUBLIC_POSTHOG_KEY` = the project key
   - `NEXT_PUBLIC_POSTHOG_HOST` = `https://us.i.posthog.com` (or EU host if you chose the EU region)

### 5c. GitHub Actions secrets (not needed today)

Vercel's native GitHub integration handles preview deploys. We only need GH Secrets later if we want CI to deploy via Vercel CLI:

- `VERCEL_TOKEN` (Vercel account settings → Tokens)
- `VERCEL_ORG_ID` (from `.vercel/project.json` after `vercel link`)
- `VERCEL_PROJECT_ID` (same source)

---

## 6. Handoff back to Claude

When the above is done, paste the following back into chat:

- ✓ Vercel project URL: `_______________________________`
- ✓ Supabase **staging** URL: `_______________________________`
- ✓ Supabase **staging** anon key: `_______________________________`
- ✓ Supabase **prod** URL: `_______________________________`
- ✓ Supabase **prod** anon key: `_______________________________`
- ✓ Extensions enabled (pgvector, pg_trgm, pgcrypto): yes / no
- ✓ Sentry DSN if set up (optional): `_______________________________`
- ✓ PostHog key if set up (optional): `_______________________________`

**Do NOT paste the `service_role` keys.** Add those to Vercel env directly (and to your local `.env.local` only). Claude will not request them.

Once Claude has the above, the next step is **Phase 0 Week 2** — Drizzle schema, migrations, RLS policies — applied to your `chessco-staging` Supabase project.

---

## Quick reference: what the env vars do

| Variable                             | Used by               | When        |
| ------------------------------------ | --------------------- | ----------- |
| `NEXT_PUBLIC_SUPABASE_URL`           | Web app (client+srv)  | Phase 0 W2+ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`      | Web app (client+srv)  | Phase 0 W2+ |
| `SUPABASE_SERVICE_ROLE_KEY`          | Workers, admin routes | Phase 0 W5+ |
| `NEXT_PUBLIC_APP_URL`                | Auth callbacks, OG    | Phase 0 W3+ |
| `LICHESS_OAUTH_CLIENT_ID/SECRET`     | Lichess OAuth         | Phase 0 W4  |
| `ANTHROPIC_API_KEY`                  | AI workers            | Phase 1 W8  |
| `STRIPE_SECRET_KEY` / webhook secret | Subscription billing  | Phase 1 W10 |
| `UPSTASH_REDIS_REST_URL/TOKEN`       | Game server, rate-lim | Phase 3 W1  |
| `SENTRY_DSN` / `NEXT_PUBLIC_*`       | Error tracking        | Phase 0 W7  |
| `NEXT_PUBLIC_POSTHOG_KEY/HOST`       | Product analytics     | Phase 0 W7  |

The full set is enumerated in [`.env.example`](../.env.example) at the repo root and [`apps/web/.env.example`](../apps/web/.env.example).
