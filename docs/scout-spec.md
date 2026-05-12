# Scout (Player Search) — Developer Specification

**Parent spec:** chessco-full-spec.md (§6 Identification, §17 UX, §25 Phase 0/1)
**Status:** Phase 0 MVP shipped on production (federation-only, server-rendered). This doc scopes the v1 evolution that unblocks Phase 1 prep reports.
**Estimated effort:** 2–3 weeks for one full-stack engineer (frontend ~1 week, API + matching orchestration ~1 week, caching + observability ~3 days)
**Priority:** Phase 0 → Phase 1 transition — the wedge feature
**Last updated:** 2026-05-12

---

## 1. Purpose

`/scout` is the entry point of the Chessco loop. The user arrives with a partial idea of who their next opponent is — a name, a federation, an online handle — and `/scout` resolves that idea into a real, identified player they can prepare against.

This spec defines the **search surface** and its **contract with the matching engine**. The matching engine's internals (Stages 2 and 3 of §6) are out of scope here — this spec defines only the API the frontend uses to call it, so engine work and surface work can ship independently.

Until `/scout` produces a player record that can feed a prep report, there is no Feature 2. So this surface is the gate to the entire paid product.

## 2. Scope

### In scope (v1, this spec)

- Single command-bar input with structured parsing (free text, country code, FIDE ID, online handle)
- Filter chips (country, federation, title, rating range)
- Client-driven search calling a new `/api/scout/search` endpoint
- Stage 1 (anchor resolution against `federation_players`) for every query
- Stage 2 enrichment (candidate online accounts) when the anchor candidate has linked `external_accounts` cached
- Confidence labels (`high` / `medium` / `low` / `none`) on each result
- Evidence panel showing why a candidate ranks where it does
- "Build prep report" CTA wired to `/reports/new?target_player_id=…`
- Edge caching of query → result for repeated identical searches
- Rate limiting via Upstash Redis (anon: 30/min, authenticated: 120/min)

### Deferred to v2 / later phases

- Live Stage 3 stylometric verification at query time (Phase 1 deliverable; Phase 0 returns Stage 1 + cached Stage 2 only)
- Streaming results (single response is sufficient for v1; SSE/streaming added when Stage 3 lands and per-stage latency justifies it)
- Federation browse mode (`/scout/federation/{id}`) — split into its own spec
- Autocomplete / typeahead — v1 ships a "Search" button; instant-search is a v1.5 polish
- Saved searches and recent-query history per user

### Explicitly NOT this surface

- The matching engine's internal stages (Stages 2 and 3) — that's `matching-engine-spec.md` (to be written)
- The prep report generation pipeline — that's `prep-report-spec.md` (Phase 1)
- The player profile page (`/p/[player_id]`) — already shipped, see §17 of the parent spec

## 3. Current State (Phase 0 MVP)

Shipped at https://chessco.org/scout (commit `54d91cb`, Week 6):

- Next.js Server Component at `apps/web/app/scout/page.tsx` reads `searchParams`
- Calls `supabase.rpc('search_federation_players', …)` directly from the server (no API route, no client JS for search)
- Returns top 20 federation candidates ordered by trigram similarity → standard rating
- Pagination via `?page=N` query string
- Filter chips: country, federation, title, min/max rating
- Result cards link to `/p/[player_id]` profile page
- Total indexed at this writing: **755,081 FIDE + 6,818 ICF players**

The MVP is intentionally minimal: no online-account enrichment, no confidence labels, no evidence, no "Build prep report" CTA. That's what v1 adds.

### Why move off direct server-component RPC

The direct `supabase.rpc()` call from a Server Component was right for the MVP but blocks three things v1 needs:

1. **Stage 2/3 orchestration** — the matching engine has to compose multiple async fetches (online-account candidates, recent activity, stylometric features). That doesn't belong in a page render; it belongs in an API route the engine can own.
2. **Client-side refinement** — v1 wants partial-input feedback ("found 12 candidates for `tel`") before the user commits. That requires a client fetch.
3. **Rate limiting** — anonymous users on the homepage CTA path can hit `/scout` without auth. We need per-IP throttling, which is awkward inside a Server Component.

## 4. Search Input

### 4.1 The command bar

A single `<input type="search">` accepting any of these query shapes. The frontend does **lightweight** parsing to determine which filter chips to pre-fill; the server-side parser is authoritative.

| Input pattern                  | Parsed as                                                          | Example                                                  |
| ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Free text (latin or non-latin) | name fuzzy match                                                   | `magnus carlsen`, `Müller`, `gukesh`                     |
| Numeric, 5–8 digits            | FIDE ID candidate (also tries USCF if FIDE miss)                   | `2806139`                                                |
| 3-letter all-caps token        | Country/federation code; remaining text becomes name               | `GM ISR Telem`, `NOR carlsen`                            |
| Token containing `@` or `/`    | Online handle hypothesis (Lichess or chess.com), routes to Stage 2 | `@DrNykterstein`, `chess.com/penguingm1`                 |
| Two tokens separated by comma  | "Last, First" — common from FIDE list paste                        | `Carlsen, Magnus`                                        |
| Mixed: name + numeric range    | Name + rating-range parse                                          | `carlsen 2700-2900`                                      |

Empty query is valid — it means "let the filter chips drive the search."

### 4.2 Filter chips (below the input)

Persistent UI, prefilled from URL query string (`?country=ISR&title=GM&min=2200`). Backed by the same form as the MVP, restyled as inline chips that update the URL on change.

| Chip            | Type         | Source                                                                       |
| --------------- | ------------ | ---------------------------------------------------------------------------- |
| Country         | dropdown     | 3-letter FIDE federation codes (existing `COMMON_COUNTRIES` in `search-form.tsx`) |
| Federation      | dropdown     | `federations` table — FIDE, USCF, ICF, ECF, DSB, etc. (defaults to "all")    |
| Title           | dropdown     | GM/WGM/IM/WIM/FM/WFM/CM/WCM/NM/WNM                                           |
| Rating range    | dual slider  | 1000–3000, step 50                                                           |
| Has online play | toggle       | Only show candidates with at least one linked `external_account`             |

### 4.3 Empty state (no query, no filters)

- Headline: "Find a chess player"
- Sub: "Search 755k+ FIDE-rated players, 6.8k Israeli players. More federations weekly."
- Sample query chips (clickable):
  - `magnus carlsen`
  - `kasparov`
  - `GM ISR` (filter, not name)
  - `2700+`
- A short explainer: "Trigram fuzzy match — typos and partial names work. Country codes are 3-letter FIDE."

### 4.4 Zero-result state

- "No players match `<query>`."
- Hint: "Try a shorter query, a different country code, or remove the rating range."
- Show two CTAs:
  - "Browse by federation →" (links to `/scout/federation/FIDE`, v2 surface)
  - "Help us find them →" (links to `mailto:hello@chessco.org` with the query prefilled — manual escalation for v1; backed by a real form later)

## 5. Matching Pipeline Call (frontend ↔ engine contract)

### 5.1 Single endpoint, single response (v1)

```
POST /api/scout/search
```

One round-trip. The endpoint orchestrates Stage 1 always; runs Stage 2 enrichment in parallel for the top N anchor candidates only if cached online-account data exists; **does not** run live Stage 3 in v1.

Response is a single JSON payload. No streaming.

### 5.2 Why not streaming in v1

Stage 1 alone returns in <200ms against the indexed `federation_players`. Stage 2 cached lookups add ~50ms per candidate (parallel, bounded). Total p95 well under 600ms — fast enough that streaming infrastructure (SSE handshake, partial render coordination) is not worth the complexity.

Streaming becomes worthwhile when Stage 3 lands (live stylometric verification on cold candidates can take 2–8s) — that's v2.

### 5.3 Loading state

- The search button enters a `disabled + spinner` state on submit
- The result region renders a skeleton (3 placeholder cards) within 100ms of the submit
- If the request exceeds 1.5s, swap the skeleton for a "Crunching style data…" message (sets expectation for slower Stage 2 cases)
- If the request exceeds 8s, show a "Search is taking longer than usual. Try a tighter filter." inline error and offer cancel

### 5.4 Cancellation

The fetch is bound to an `AbortController` keyed off the input value. Typing a new query within 250ms of the previous submission cancels the in-flight request and starts a new one. Server-side, the cancelled request short-circuits before any expensive enrichment.

## 6. API Contract

### 6.1 Request

```http
POST /api/scout/search HTTP/1.1
Content-Type: application/json

{
  "q": "carlsen magnus",
  "filters": {
    "country": "NOR",
    "federation": null,
    "title": null,
    "rating_min": null,
    "rating_max": null,
    "has_online_play": false
  },
  "page": 1,
  "page_size": 20,
  "include": ["anchors"]
}
```

Field reference:

| Field                       | Type                          | Default     | Notes                                                                              |
| --------------------------- | ----------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `q`                         | string                        | `""`        | Raw query string. Server parses per §4.1.                                          |
| `filters.country`           | string \| null                | null        | 3-letter FIDE code                                                                 |
| `filters.federation`        | string \| null                | null        | `FIDE`, `USCF`, `ICF`, etc. — values from `federations.id`                         |
| `filters.title`             | string \| null                | null        | Title code                                                                         |
| `filters.rating_min`        | integer \| null               | null        | Inclusive, applied against `rating_standard`                                       |
| `filters.rating_max`        | integer \| null               | null        | Inclusive                                                                          |
| `filters.has_online_play`   | boolean                       | false       | If true, only return anchors that have at least one cached `external_accounts` row |
| `page`                      | integer                       | 1           |                                                                                    |
| `page_size`                 | integer                       | 20          | Max 100                                                                            |
| `include`                   | enum array                    | `["anchors"]` | `"anchors"` always included; `"online_accounts"` opts into Stage 2 enrichment    |

### 6.2 Response (success)

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, max-age=30

{
  "results": [
    {
      "id": "uuid-...",
      "anchor": {
        "federation_id": "FIDE",
        "federation_player_id": "1503014",
        "name": "Carlsen, Magnus",
        "country": "NOR",
        "title": "GM",
        "rating_standard": 2839,
        "rating_rapid": 2826,
        "rating_blitz": 2886,
        "birth_year": 1990
      },
      "online_accounts": [
        {
          "platform": "lichess",
          "external_id": "DrNykterstein",
          "verified": false,
          "last_seen_at": "2026-05-09T14:21:00Z"
        }
      ],
      "confidence": {
        "label": "high",
        "score": 0.94,
        "stages_run": ["anchor", "online_accounts"]
      },
      "evidence": [
        { "kind": "name_match",     "detail": "Exact trigram match on 'carlsen magnus'", "weight": 0.6 },
        { "kind": "country_match",  "detail": "Country filter NOR matches anchor country NOR", "weight": 0.15 },
        { "kind": "online_handle",  "detail": "DrNykterstein on Lichess — name-similarity 0.71, country match", "weight": 0.19 }
      ]
    }
  ],
  "total_count": 1,
  "page": 1,
  "page_size": 20,
  "took_ms": 187,
  "stages_run": ["anchor", "online_accounts"]
}
```

Confidence labels (mirrors §6 of the parent spec):

| Label    | Combined score | Display                                                                       |
| -------- | -------------- | ----------------------------------------------------------------------------- |
| `high`   | > 0.80         | Green dot + label; "Build prep report" is the primary CTA                     |
| `medium` | 0.60 – 0.80    | Yellow dot + label; CTA is "Build prep report" with a "review evidence" prompt |
| `low`    | 0.40 – 0.60    | Gray dot + label; CTA reads "Use anyway" to let user decide                   |
| `none`   | < 0.40         | Result is filtered out before returning (don't render guesses)                |

`stages_run` tells the frontend which stages contributed, so the evidence panel can label its sources clearly ("based on name match only" vs "name + online play").

### 6.3 Response (validation error)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "invalid_filter",
  "message": "rating_min must be between 0 and 3000",
  "field": "filters.rating_min"
}
```

### 6.4 Response (rate limited)

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 35
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1715517625

{
  "error": "rate_limited",
  "message": "Too many search requests. Retry in 35 seconds, or sign in for a higher limit.",
  "retry_after_seconds": 35
}
```

Limits:

| Identity         | Window       | Limit  |
| ---------------- | ------------ | ------ |
| Anon (per IP)    | 60 seconds   | 30     |
| Authenticated    | 60 seconds   | 120    |
| Per-user burst   | 1 second     | 5      |

### 6.5 Response (engine error)

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "error": "engine_error",
  "message": "Matching engine could not complete this query. Please try again.",
  "request_id": "req_..."
}
```

The frontend never reveals the stack. `request_id` is the only thing surfaced for support tickets.

## 7. Result List & Cards

### 7.1 Card anatomy

```
┌─────────────────────────────────────────────────────────────────────┐
│ [FIDE] [GM] [NOR]                       Std    Rapid   Blitz        │
│ Carlsen, Magnus                         2839   2826    2886         │
│ FIDE ID 1503014 · born 1990                                          │
│                                                                       │
│ ● high   ▸ Build prep report   ▸ View profile                        │
│                                                                       │
│ ┌─ Evidence ───────────────────────────────────────────────────┐    │
│ │ • Exact name match (trigram 1.0)                              │    │
│ │ • Country filter NOR matches anchor country                   │    │
│ │ • DrNykterstein on Lichess — name-similarity 0.71             │    │
│ └────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

Card layout reuses the existing `apps/web/app/scout/result-card.tsx` as the structural baseline. v1 adds:

- A confidence dot + label (top-right of the action row)
- A "Build prep report" CTA (primary action button)
- A collapsible evidence panel (collapsed by default; expand on click)
- An online-account chip row when `online_accounts` is non-empty

The existing badges (FederationBadge / TitleBadge / CountryBadge) stay as-is.

### 7.2 Evidence panel

Collapsed by default. Renders the `evidence[]` array from the response as a bullet list, sorted by `weight` descending. Each bullet shows the human-readable `detail`. The panel is purely informational — it does not let the user reweight or override the ranking in v1.

When `stages_run` includes only `anchor`, the panel renders a footer note: "Online accounts and style verification will improve this match once we crawl their public games." This sets expectations for Phase 0/1 boundary cases.

### 7.3 "Build prep report" CTA wiring

Click navigates to:

```
/reports/new?target_player_id=<result.id>
```

In Phase 0, `/reports/new` is a placeholder page (Phase 1 deliverable). In Phase 0 the placeholder reads: "Prep reports are coming in Phase 1. We've saved this player to your watchlist — you'll be notified when reports launch." This still captures intent and lets the team measure CTA conversion before building the engine.

### 7.4 Pagination

Existing `?page=N` pagination from the MVP carries over. v1 keeps server-driven pagination for now (no infinite scroll). 20 results per page.

## 8. Caching

Three layers, each with a clear role:

### 8.1 Edge cache (Vercel)

```
Cache-Control: private, max-age=30
```

Same `(q, filters)` combination served from the edge for 30 seconds. Private — never shared across users (since rate-limit headers and personalized fields like `has_online_play` filter on the calling user's perspective). 30s is short enough that fresh ratings show up within a minute, long enough to absorb pagination clicks and back-button traffic.

### 8.2 App cache (Upstash Redis)

```
Key:   scout:search:<sha256(canonical_request_json)>
Value: full response payload
TTL:   5 minutes
```

Canonical request hash: lowercase trim of `q`, normalize filter object (sorted keys, null-stripped), `page`, `page_size`, `include`. Identical canonical requests from different users share the cache entry, since results are deterministic given those inputs.

Invalidation: TTL only in v1. After Phase 1 lands rating-list ingestion churn, add explicit invalidation on `federation_players` upsert batches that touch matched IDs.

### 8.3 Database (Postgres)

The `search_federation_players` RPC is already `STABLE` and runs against a GIN trigram index on `name_normalized`. No additional caching needed at the DB layer. The RPC plan is the same in v1.

Stage 2 online-account lookups read from `external_accounts` directly — that table is small (today < 50k rows) and indexed by `(profile_id, platform)`. No caching needed; if it grows past 500k rows, consider materializing a `federation_player_id → linked_handles` projection.

### 8.4 What does NOT get cached

- The per-user rate-limit counter — Redis-backed, never cached
- The "has the user clicked Build prep report yet" CTA state — that's a watchlist row, not cache
- Anonymous queries that hit zero results — caching empty results would surface stale zeroes after new federations land. TTL these for 60s only (override the 5min default).

## 9. Edge Cases & Failure Modes

| Case                                                                  | Handling                                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Query is empty AND all filters are null                               | Return empty results with `total_count: 0`; UI shows the empty state, not "no results"                                                  |
| Query is whitespace-only                                              | Treat as empty                                                                                                                          |
| Query is one character                                                | Allow but warn ("`?` is too short — try a longer query") inline below input; still run the search (some federations have 1-char nicks)  |
| Query is >100 characters                                              | Reject with `invalid_query` (400); UI surfaces inline error                                                                             |
| User pastes a chess.com profile URL                                   | Strip to the handle, parse as handle hypothesis (Stage 2 priority)                                                                      |
| FIDE ID in query but it doesn't exist in our DB                       | Stage 1 returns empty; response still 200 with empty array; frontend shows zero-result state with "Player not yet in our federation index" copy |
| Stage 2 enrichment times out (>800ms)                                 | Return Stage 1 results only; `stages_run` reflects that; log warning; do not 500                                                        |
| Supabase RPC errors                                                   | 500 with `engine_error`; log full error server-side, return only `request_id` to client                                                 |
| Rate limit hit                                                        | 429 with `Retry-After`; UI shows "Try again in Xs" toast                                                                                |
| Filter `rating_min > rating_max`                                      | 400 with `invalid_filter`                                                                                                               |
| Filter `country` is not a 3-letter code                               | 400 with `invalid_filter`                                                                                                               |
| Page > total_pages                                                    | Return empty `results` array but valid `total_count`; UI shows "Page N is past the last page" with a link to page 1                     |
| Two simultaneous in-flight queries from same client                   | `AbortController` cancels the earlier; server short-circuits cancelled requests                                                         |
| User cancels mid-flight (navigates away)                              | Request aborts cleanly; partial work is not billed against rate-limit                                                                   |
| Cache poisoning attempt (handcrafted bad cache key)                   | Cache key is server-derived from canonical request, not user-supplied; impossible by construction                                       |

## 10. Observability

### 10.1 Per-request log

Every `/api/scout/search` call writes a structured log line:

```json
{
  "ts": "2026-05-12T12:34:56Z",
  "request_id": "req_...",
  "user_id": "user_...",   // or null for anon
  "ip_hash": "sha256(...)",
  "q_length": 14,
  "filters_present": ["country"],
  "page": 1,
  "stages_run": ["anchor", "online_accounts"],
  "took_ms": 187,
  "result_count": 1,
  "cache_hit": "app",      // "edge" | "app" | "miss"
  "rate_limit_remaining": 27
}
```

The raw query string is **not** logged (privacy). Length and filter shape are sufficient for product analytics.

### 10.2 Metrics (Grafana / Vercel Analytics)

- p50 / p95 / p99 latency on `/api/scout/search`
- Cache hit rate by layer (edge / app / miss)
- Rate-limit rejection rate
- Distribution of `stages_run` (how often does Stage 2 fire)
- Click-through rate from result card to "Build prep report"
- Click-through rate from result card to `/p/[player_id]`

### 10.3 Alerts

| Condition                                       | Severity | Action                       |
| ----------------------------------------------- | -------- | ---------------------------- |
| p95 latency > 1500ms for 5 minutes              | warn     | Slack #ops                    |
| Engine-error rate > 1% over 5 minutes           | crit     | Slack #ops + PagerDuty       |
| Cache hit rate < 30% (after warm-up)            | info     | Slack #ops, look for poisoning or bad invalidation |
| Rate-limit rejections > 100/min                 | warn     | Slack #ops, check for abuse  |

## 11. Acceptance Criteria

Before merging /scout v1 to production:

1. **API contract conforms to §6** — schema validator against the request/response shapes returns no errors on 100 synthetic queries
2. **Stage 1 only path** completes p95 < 500ms (10k synthetic queries against prod-shaped data)
3. **Stage 1 + Stage 2 path** completes p95 < 800ms when online-account cache is warm
4. **Rate limits enforced** — automated test that 31 anon requests in 60s gets one 429
5. **Cache hit rate ≥ 60%** after a 5-minute warm-up on the top 100 most-common queries
6. **All filter combinations from §4.2** produce correct results — verified against 30 hand-curated test cases
7. **Confidence labels align with §6.2** — randomly sampled 50 high/medium/low results manually inspected, no obviously-wrong label
8. **"Build prep report" CTA** correctly navigates with `target_player_id` for high-confidence and medium-confidence results
9. **Evidence panel** renders the `evidence[]` array in weight-descending order for every result
10. **MVP fallback works** — if `/api/scout/search` is hard-deleted, the existing Server Component path at `/scout?q=…` still functions (graceful degradation during deploy)
11. **No raw query text in logs** — privacy review confirms (grep for `"q":` against 1 hour of prod log sample)
12. **Lighthouse score ≥ 95** on `/scout` (mobile + desktop)

## 12. Out of Scope (for now)

- **Live Stage 3 stylometric verification** — Phase 1 deliverable. v1 surfaces Stage 1 + cached Stage 2 only.
- **Streaming / SSE responses** — single response is sufficient until Stage 3 latency justifies it.
- **Federation browse mode** (`/scout/federation/{id}`) — separate spec.
- **Autocomplete / typeahead** — v1.5 polish, not a v1 blocker.
- **Saved searches per user** — Phase 1 dashboard feature.
- **Search analytics dashboard for admins** — covered by general /admin instrumentation, not this spec.
- **Locale-aware name matching** (Cyrillic ↔ Latin transliteration beyond NFD-strip) — Phase 2; today's normalizer covers Western European diacritics, not script conversions.
- **Search by opening / style** — that's the "find me a Najdorf player" inversion. Not in scope for v1; arguably part of the matching engine spec.

## 13. Future Iterations

After v1 ships, in rough priority order:

- **v1.5: typeahead** — debounced GET `/api/scout/suggest?q=…` returning top 5 anchors with confidence ≥ 0.6. Same caching, lower TTL.
- **v2.0: streaming** — SSE response stream once Stage 3 lands; per-stage incremental rendering.
- **v2.1: federation browse mode** — SEO-driven static pages mirroring SnoopChess discoverability.
- **v2.2: stylometric query** — "find Najdorf-leaning IMs in IL rated 2200–2400."
- **v2.3: opt-in identity scoping** — users can flag their own anonymous accounts as discoverable.
- **v3.0: cross-platform fingerprint** — single embedding across Lichess + chess.com + OTB games; query by sample PGN.

## 14. Implementation Checklist

- [ ] New route file `apps/web/app/api/scout/search/route.ts` (POST handler)
- [ ] Request validator with Zod schema matching §6.1
- [ ] Rate-limit middleware using Upstash Redis (per §6.4)
- [ ] Server-side query parser implementing §4.1 (extracted to `apps/web/lib/scout/parse-query.ts` for testability)
- [ ] Stage 1 orchestrator calling `search_federation_players` RPC
- [ ] Stage 2 enrichment (parallel fan-out to `external_accounts` per anchor; bounded 800ms timeout)
- [ ] Confidence scoring & evidence assembly (per §6.2)
- [ ] App-cache layer with canonical request hashing (per §8.2)
- [ ] Frontend `/scout` page converted to Client Component for the result region (form + filters remain server-rendered for SEO)
- [ ] New `<ResultCard>` variant supporting confidence + evidence + CTA (extend existing component)
- [ ] Skeleton + loading states (per §5.3)
- [ ] `AbortController` cancellation glue
- [ ] `/reports/new` placeholder page that captures `target_player_id` to a `watchlist` table
- [ ] Structured logging (per §10.1)
- [ ] Grafana dashboard for the metrics in §10.2
- [ ] Slack alerts wired per §10.3
- [ ] Unit tests for query parser (100 cases)
- [ ] Integration test that runs Stage 1 + Stage 2 against a fixture DB
- [ ] Load test: 1k req/s sustained for 60s against staging, p95 < 800ms
- [ ] Documented runbook at `ops/runbooks/scout.md` covering: how to bust cache, how to inspect a request_id, how to escalate engine errors
- [ ] Privacy review sign-off (no raw query text in logs, anon rate-limit per IP-hash not IP)
- [ ] Production smoke test against 50 known queries with expected top-result IDs

---

**End of /scout specification.**
