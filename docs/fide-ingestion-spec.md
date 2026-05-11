# FIDE Ratings Ingestion Worker — Developer Specification

**Parent spec:** chessco-full-spec.md (§5, §6, §25 Phase 0)
**Status:** Ready for development
**Estimated effort:** 1–2 weeks for one full-stack engineer
**Priority:** Phase 0 — first ingestion worker to ship
**Last updated:** 2026-05-11

---

## 1. Purpose

The FIDE Ratings Ingestion Worker is the first ingestion job in the Chessco data pipeline. It populates the `federations` and `federation_players` tables with the canonical FIDE rating list, refreshed monthly.

This is foundational. Every downstream Feature 1 query depends on `federation_players` being populated and current. No identification, no prep reports, no marketplace match-quality without it.

## 2. Source

**Authoritative source:** FIDE's monthly downloads page at https://ratings.fide.com/download.phtml

FIDE publishes monthly rating lists in multiple formats. We use the **XML format** because it is structured, complete, and includes all rating categories in one file.

Files of interest (current naming, as of 2026):

| File                           | Contents                                | Update cadence         |
| ------------------------------ | --------------------------------------- | ---------------------- |
| `standard_rating_list_xml.zip` | All players with a standard FIDE rating | Monthly (1st of month) |
| `rapid_rating_list_xml.zip`    | All players with a rapid rating         | Monthly                |
| `blitz_rating_list_xml.zip`    | All players with a blitz rating         | Monthly                |

Each zip contains one XML file. The XML schema is documented at the FIDE site; the relevant fields per player are listed in §4 below.

**Size and scale:** Each XML is roughly 50–150MB uncompressed, containing ~400k–500k player records. Combined dataset across all three rating types: ~600k–800k distinct players (most rated only in standard).

**Licensing:** FIDE rating lists are published as public records. Verify current terms-of-use before commercial deployment; if FIDE adds usage restrictions, fall back to scraping their public ratings pages individually (slower, same data).

## 3. Worker Architecture

### Runtime

- **Job framework:** Inngest (per main spec §4 Tech Stack)
- **Trigger:** Cron — `0 4 5 * *` (every month on the 5th at 04:00 UTC). FIDE typically publishes on the 1st; the 4-day delay ensures the file is stable.
- **Manual trigger:** Admin button at `/admin/ingestion/fide` for forced re-sync
- **Concurrency:** 1 (singleton; do not run two FIDE ingests simultaneously)
- **Timeout:** 60 minutes per run

### Steps

```
1. fetch     → download three .zip files from FIDE
2. extract   → unzip each into temp directory
3. parse     → stream-parse XML (do NOT load into memory)
4. normalize → map FIDE fields to federation_players schema
5. diff      → compare against existing records, identify inserts/updates
6. upsert    → bulk upsert to Postgres
7. snapshot  → write rating snapshots for trend tracking
8. cleanup   → delete temp files
9. notify    → post stats to Slack admin channel
```

### Streaming requirement

The XML files are large. Do **not** load them into memory. Use a streaming parser:

- **Node.js:** `sax` (event-driven) or `node-expat`
- **Python (alternative if worker is Python-based):** `lxml.etree.iterparse` with `clear()` after each element

Pseudocode (Node + sax):

```javascript
import { createReadStream } from 'fs';
import sax from 'sax';

const parser = sax.createStream(true, { trim: true });
let currentPlayer = null;
const batch = [];

parser.on('opentag', (node) => {
  if (node.name === 'player') currentPlayer = { ...node.attributes };
});

parser.on('text', (text) => {
  // collect text into current field
});

parser.on('closetag', async (name) => {
  if (name === 'player') {
    batch.push(normalize(currentPlayer));
    if (batch.length >= 1000) {
      await upsertBatch(batch.splice(0));
    }
  }
});

parser.on('end', async () => {
  if (batch.length > 0) await upsertBatch(batch);
});

createReadStream(xmlPath).pipe(parser);
```

### Batching

Upsert in batches of 1000 rows. Use Postgres `INSERT ... ON CONFLICT (federation_id, federation_player_id) DO UPDATE` for upsert semantics.

## 4. FIDE XML Schema Mapping

The XML format (from FIDE's `players_list_xml.xml` and rating-specific variants) contains records like:

```xml
<player>
  <fideid>2806139</fideid>
  <name>Carlsen, Magnus</name>
  <country>NOR</country>
  <sex>M</sex>
  <title>GM</title>
  <w_title></w_title>
  <o_title></o_title>
  <foa_title></foa_title>
  <rating>2839</rating>
  <games>0</games>
  <k>10</k>
  <birthday>1990</birthday>
  <flag></flag>
</player>
```

Field mapping to `federation_players`:

| FIDE XML                      | `federation_players` column | Notes                                                                                                                |
| ----------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `fideid`                      | `federation_player_id`      | Always present; primary identifier within FIDE                                                                       |
| `name`                        | `name`                      | "Carlsen, Magnus" — store as-is for display                                                                          |
| `name` (transformed)          | `name_normalized`           | Lowercase, strip diacritics, strip commas: "carlsen magnus"                                                          |
| `country`                     | `country`                   | 3-letter FIDE federation code (NOR, ISR, USA); store as-is, also derive ISO 3166-1 alpha-2 in a join table if needed |
| `sex`                         | `gender`                    | 'M' or 'F'                                                                                                           |
| `title`                       | `title`                     | GM/IM/FM/CM/NM (the most authoritative title)                                                                        |
| `rating` (from standard list) | `rating_standard`           | Integer; null if not on standard list                                                                                |
| `rating` (from rapid list)    | `rating_rapid`              | Integer; null if not on rapid list                                                                                   |
| `rating` (from blitz list)    | `rating_blitz`              | Integer; null if not on blitz list                                                                                   |
| `birthday`                    | `birth_year`                | Year only (FIDE publishes year, not full DOB)                                                                        |
| `flag`                        | (ignored)                   | FIDE inactivity flag; can be stored in `raw` jsonb if useful                                                         |
| `federation_id`               | (constant 'FIDE')           | Set during ingestion                                                                                                 |
| All raw fields                | `raw` (jsonb)               | Store entire original record for diffing and audit                                                                   |

### Name normalization rules

```
"Carlsen, Magnus"   → "carlsen magnus"
"García, José M."   → "garcia jose m"
"O'Brien, Patrick"  → "obrien patrick"
"Müller, Hans"      → "muller hans"
"Çağdaş, Onur"      → "cagdas onur"
```

Steps:

1. Lowercase
2. Strip diacritics (NFD normalize, remove combining marks)
3. Strip apostrophes, periods, commas
4. Collapse multiple spaces to single space
5. Trim

This normalized form is what the trigram index searches against.

### Title precedence

A player may appear with multiple titles. Use this precedence (highest to lowest) when populating the `title` field:

`GM > WGM > IM > WIM > FM > WFM > CM > WCM > NM > WNM > (empty)`

Store the highest applicable. Store the full set of titles in `raw` for completeness.

### Merging across rating lists

The three rating lists (standard, rapid, blitz) each contain the same player with a different rating. The ingestion logic must:

1. Process all three files in sequence
2. For each player (keyed by `fideid`), merge ratings into a single `federation_players` row
3. If a player appears in two lists but the name/title differs slightly, the **standard list takes precedence** (FIDE treats standard as canonical)

Implementation: process standard first (insert), then rapid (update rapid rating column), then blitz (update blitz rating column).

## 5. Diff & Snapshot Logic

### Diff (what changed since last month)

Before upserting, compare each incoming record against the existing `federation_players` row:

- **New player** (no existing row) → insert
- **Rating changed** → update + write snapshot row
- **Title changed** → update + write snapshot row + log to admin
- **Name changed** → update + log to admin (rare but happens — marriage, transliteration corrections)
- **Country changed** → update + log to admin (federation transfers are notable)
- **No change** → skip

### Snapshot writes

For every update where `rating_standard`, `rating_rapid`, `rating_blitz`, or `title` changed, write a row to `federation_rating_snapshots`:

```sql
INSERT INTO federation_rating_snapshots (
  federation_player_id, snapshot_date,
  rating_standard, rating_rapid, rating_blitz, title
) VALUES (...)
```

`snapshot_date` is the FIDE list date (parsed from filename or XML metadata), not the ingestion date.

For new players, write an initial snapshot.

## 6. Edge Cases & Failure Modes

| Case                                                                   | Handling                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| FIDE site is down                                                      | Retry with exponential backoff (3 attempts, 1h apart); after 3 failures, alert admin and skip this month                       |
| File checksum mismatch                                                 | Re-download once; if still mismatched, alert and skip                                                                          |
| XML parse error mid-file                                               | Log the offending element and continue; do not abort the entire run                                                            |
| Player has a fideid that doesn't match expected format                 | Log and skip that record                                                                                                       |
| Duplicate fideid within the same file (shouldn't happen but defensive) | First occurrence wins; log warning                                                                                             |
| Player removed from FIDE list (no longer present)                      | Do **not** delete; set `last_updated_at` and a `removed_from_list_at` if not seen for 3 consecutive months — preserves history |
| Country code is unknown                                                | Store anyway, do not block; flag for review                                                                                    |
| Birth year is missing or implausible (< 1900 or > current year)        | Store as null                                                                                                                  |
| Rating is implausible (< 1000 or > 3000)                               | Store anyway, log warning                                                                                                      |
| Connection drops mid-stream                                            | Resume from last successful batch checkpoint if possible; otherwise restart                                                    |
| Database upsert deadlock                                               | Retry the batch with exponential backoff                                                                                       |

## 7. Observability

### Per-run metrics (log to admin dashboard)

- Start time, end time, duration
- Bytes downloaded
- Records parsed (per file)
- Records inserted (new players)
- Records updated (existing players, any change)
- Records skipped (no change)
- Snapshots written
- Errors encountered (with sample messages)

### Slack notification on completion

```
✓ FIDE ingestion completed in 12m 34s
  • Standard: 412,118 players (1,243 new, 38,217 updated)
  • Rapid: 287,394 players (892 new, 22,118 updated)
  • Blitz: 261,773 players (845 new, 21,489 updated)
  • Snapshots written: 81,824
  • Errors: 3 (see /admin/ingestion/fide/runs/{run_id})
```

### Failure notification

```
✗ FIDE ingestion failed at step: parse
  Run ID: ...
  Error: XML parse error at line 1,243,109
  Last successful batch: standard #412
```

## 8. Acceptance Criteria

Before merging this worker to production:

1. **End-to-end run completes** against the most recent FIDE rating list in under 30 minutes on production infra
2. **Player counts match FIDE published totals** within 1% margin (FIDE's own count vs. our row count)
3. **Spot checks pass** for 20 random players: pick 20 FIDE IDs across federations and titles, verify name/country/title/rating match FIDE's online profile
4. **Idempotency:** running the worker twice in succession produces zero new updates on the second run
5. **Failure recovery:** killing the worker mid-parse and restarting produces a complete and correct dataset
6. **Snapshot integrity:** for any player with a rating change, exactly one snapshot row is written per ingestion run
7. **Trigram search works:** `SELECT * FROM federation_players WHERE name_normalized % 'carlsen magnus' LIMIT 10` returns Magnus Carlsen as the top result in under 100ms
8. **Admin run history page** at `/admin/ingestion/fide` shows the last 12 runs with metrics

## 9. Out of Scope (For Now)

The following are explicitly **not** part of this worker:

- USCF ingestion (separate worker, similar pattern)
- Other national federations (ECF, DSB, FSI, FFE — all separate workers per Phase 2)
- Linking `federation_players` to online accounts (that's the Stage 2 matching job, Phase 1)
- Linking `federation_players` to the canonical `players` table (deferred until first match query needs it; can be lazy)
- Historical FIDE lists (only ingest current — backfill is a later, optional one-off job)
- FIDE tournament results / cross-tables (not in monthly XML; would require Chess-Results integration)

## 10. Future Iterations

After v1 ships, consider:

- **Historical backfill** of FIDE lists back to 2010 for richer rating-trajectory analysis
- **Live FIDE profile enrichment** (their HTML profile pages contain tournament history; scrape sparingly on demand for a specific player when their profile is viewed)
- **Title norms & achievements** — FIDE publishes title-norm achievements separately; could enrich player profiles
- **Junior / arbiter / trainer titles** — non-playing titles for the broader chess community

---

## 11. Implementation Checklist (for the developer)

- [ ] Inngest function `fideIngestion` registered with the cron trigger
- [ ] Download module with retry + integrity check
- [ ] Streaming XML parser with batched accumulation
- [ ] Name normalizer (with unit tests on a 50-name fixture)
- [ ] Schema migration for `federations`, `federation_players`, `federation_rating_snapshots` (per main spec §5)
- [ ] Trigram extension enabled, GIN index created on `name_normalized`
- [ ] Upsert batching with `ON CONFLICT` handling
- [ ] Diff logic comparing incoming vs. existing
- [ ] Snapshot writer
- [ ] Admin run history table + page
- [ ] Slack webhook integration for success/failure notifications
- [ ] Manual-trigger button in admin
- [ ] Documented runbook at `ops/runbooks/fide-ingestion.md` covering: how to manually trigger, how to debug a failed run, how to roll back a bad run
- [ ] Integration test that runs the full pipeline against a small fixture XML (20 players)
- [ ] Production smoke test against the current month's real file

---

**End of FIDE ingestion specification.**
