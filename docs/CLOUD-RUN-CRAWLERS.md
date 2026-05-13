# Cloud Run Crawlers — Operational Runbook

Pillar D of the production-scale plan. Six Cloud Run jobs (four for
chess.com, two for Lichess) each pulling from the shared queue with a
distinct egress IP per region. The `crawler-watchdog` Inngest function
dispatches them every 15 minutes when work is pending.

## One-time GCP setup

### 1. Build + push the images (once per code change)

From the monorepo root on any machine with `docker` and `gcloud`:

```bash
gcloud auth configure-docker

# chess.com image
docker build -f apps/workers/Dockerfile.chesscom-crawl \
  -t gcr.io/<PROJECT_ID>/chessco-chesscom-crawl:latest .
docker push gcr.io/<PROJECT_ID>/chessco-chesscom-crawl:latest

# Lichess image
docker build -f apps/workers/Dockerfile.lichess-crawl \
  -t gcr.io/<PROJECT_ID>/chessco-lichess-crawl:latest .
docker push gcr.io/<PROJECT_ID>/chessco-lichess-crawl:latest
```

### 2. Stage secrets in Secret Manager

```bash
# Cloud SQL credentials (shared by every region)
echo -n "<host>"     | gcloud secrets create GAMES_DB_HOST --data-file=-
echo -n "<port>"     | gcloud secrets create GAMES_DB_PORT --data-file=-
echo -n "<user>"     | gcloud secrets create GAMES_DB_USER --data-file=-
echo -n "<password>" | gcloud secrets create GAMES_DB_PASSWORD --data-file=-
echo -n "<dbname>"   | gcloud secrets create GAMES_DB_NAME --data-file=-

# Lichess personal API tokens (one per Lichess region)
# Mint each at lichess.org/account/oauth/token/create — NO scopes needed.
echo -n "<token-us>" | gcloud secrets create LICHESS_API_TOKEN_US --data-file=-
echo -n "<token-eu>" | gcloud secrets create LICHESS_API_TOKEN_EU --data-file=-
```

Grant the Cloud Run service account `roles/secretmanager.secretAccessor`.

### 3. Create the six Cloud Run jobs

Each chess.com region uses the same image + secrets, only `--region`
and the per-region env vars differ.

```bash
# Reusable function — paste into your shell
create_chesscom_job() {
  local REGION=$1
  local WORKER_ID=$2
  gcloud run jobs create chessco-chesscom-crawl-${WORKER_ID#cloud-} \
    --image gcr.io/<PROJECT_ID>/chessco-chesscom-crawl:latest \
    --region "$REGION" \
    --task-timeout 86400s \
    --memory 512Mi --cpu 1 \
    --max-retries 0 \
    --set-secrets GAMES_DATABASE_HOST=GAMES_DB_HOST:latest,\
GAMES_DATABASE_PORT=GAMES_DB_PORT:latest,\
GAMES_DATABASE_USER=GAMES_DB_USER:latest,\
GAMES_DATABASE_PASSWORD=GAMES_DB_PASSWORD:latest,\
GAMES_DATABASE_NAME=GAMES_DB_NAME:latest \
    --set-env-vars WORKER_ID="$WORKER_ID"
}

create_chesscom_job us-central1          cloud-us
create_chesscom_job europe-west1         cloud-eu
create_chesscom_job asia-east1           cloud-asia
create_chesscom_job australia-southeast1 cloud-au

# Lichess — note the per-region token mapping
create_lichess_job() {
  local REGION=$1
  local WORKER_ID=$2
  local TOKEN_SECRET=$3
  gcloud run jobs create chessco-lichess-crawl-${WORKER_ID#cloud-} \
    --image gcr.io/<PROJECT_ID>/chessco-lichess-crawl:latest \
    --region "$REGION" \
    --task-timeout 86400s \
    --memory 512Mi --cpu 1 \
    --max-retries 0 \
    --set-secrets GAMES_DATABASE_HOST=GAMES_DB_HOST:latest,\
GAMES_DATABASE_PORT=GAMES_DB_PORT:latest,\
GAMES_DATABASE_USER=GAMES_DB_USER:latest,\
GAMES_DATABASE_PASSWORD=GAMES_DB_PASSWORD:latest,\
GAMES_DATABASE_NAME=GAMES_DB_NAME:latest,\
LICHESS_API_TOKEN="${TOKEN_SECRET}:latest" \
    --set-env-vars WORKER_ID="$WORKER_ID"
}

create_lichess_job us-central1  cloud-us LICHESS_API_TOKEN_US
create_lichess_job europe-west1 cloud-eu LICHESS_API_TOKEN_EU
```

### 4. Wire env vars into the Inngest serve process

The `inngest:serve` process (running on machine #1 today) needs to know
which Cloud Run jobs to dispatch. Add these to its environment — the
watchdog reads them via `cloudRunJobFromEnv()`:

```
GCP_PROJECT_ID=<project>

CHESSCOM_CRAWL_US_REGION=us-central1
CHESSCOM_CRAWL_US_JOB_NAME=chessco-chesscom-crawl-us
CHESSCOM_CRAWL_EU_REGION=europe-west1
CHESSCOM_CRAWL_EU_JOB_NAME=chessco-chesscom-crawl-eu
CHESSCOM_CRAWL_ASIA_REGION=asia-east1
CHESSCOM_CRAWL_ASIA_JOB_NAME=chessco-chesscom-crawl-asia
CHESSCOM_CRAWL_AU_REGION=australia-southeast1
CHESSCOM_CRAWL_AU_JOB_NAME=chessco-chesscom-crawl-au

LICHESS_CRAWL_US_REGION=us-central1
LICHESS_CRAWL_US_JOB_NAME=chessco-lichess-crawl-us
LICHESS_CRAWL_EU_REGION=europe-west1
LICHESS_CRAWL_EU_JOB_NAME=chessco-lichess-crawl-eu
```

`PROJECT_ID` falls back to `GCP_PROJECT_ID` per the existing
`cloudRunJobFromEnv` helper — you don't need to repeat it per prefix.

### 5. ADC + IAM

The Inngest serve process needs `roles/run.invoker` on each Cloud Run
job (or project-wide). Locally: `gcloud auth application-default
login`. In production: bind a service account to the host.

## Smoke testing

### Per-region image smoke (local)

```bash
docker run --rm \
  -e GAMES_DATABASE_HOST=... \
  -e GAMES_DATABASE_PORT=... \
  -e GAMES_DATABASE_USER=... \
  -e GAMES_DATABASE_PASSWORD=... \
  -e GAMES_DATABASE_NAME=... \
  -e WORKER_ID=docker-smoke \
  gcr.io/<PROJECT_ID>/chessco-chesscom-crawl:latest \
  --max-items 5
```

Should claim 5 items, ingest games, exit 0.

### First Cloud Run dispatch

```bash
gcloud run jobs execute chessco-chesscom-crawl-us --region us-central1
gcloud run jobs executions list --region us-central1 \
  --job chessco-chesscom-crawl-us --limit 1
```

Check `chesscom_crawl_runs` for a row with `worker_id='cloud-us'` and
recent heartbeat.

### Watchdog smoke

From Inngest dashboard (or via `inngest:dev`), trigger the event
`chessco/crawler-watchdog.run.requested`. The function logs each
region's decision (`dispatched`, `already-running`, `no-work`,
`no-config`). All registered regions with env config + pending work
should dispatch.

## Monitoring

```sql
-- Active Cloud Run workers across both platforms (heartbeats fresh)
SELECT
  'chess.com' AS platform, worker_id, items_processed, games_inserted,
  errors, EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at)) AS hb_age_s
FROM chesscom_crawl_runs
WHERE status = 'running' AND last_heartbeat_at > NOW() - INTERVAL '15 minutes'
UNION ALL
SELECT
  'lichess', worker_id, items_processed, games_inserted, errors,
  EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at))
FROM lichess_crawl_runs
WHERE status = 'running' AND last_heartbeat_at > NOW() - INTERVAL '15 minutes'
ORDER BY platform, worker_id;
```

```sql
-- Daily throughput per worker_id (rolling 24h)
SELECT worker_id, SUM(items_processed), SUM(games_inserted), SUM(errors)
FROM chesscom_crawl_runs
WHERE started_at > NOW() - INTERVAL '24 hours'
GROUP BY worker_id ORDER BY worker_id;
```

## Stopping a region

```bash
# Cancel any currently-executing run
gcloud run jobs executions list --region us-central1 \
  --job chessco-chesscom-crawl-us
gcloud run jobs executions cancel <EXECUTION_NAME> --region us-central1

# To prevent future dispatch: remove the env vars from inngest:serve
# (or set CHESSCOM_CRAWL_US_JOB_NAME=disabled). Watchdog will report
# "no-config" for that region but won't error.
```

## Cost

At rest (queue idle, no dispatches): $0/day. Cloud Run jobs bill only
during execution.

During active bulk crawl (~7-10 days):

- 4 chess.com instances × 24h × $0.030/h = ~$2.90/day
- 2 Lichess instances × 24h × $0.030/h = ~$1.45/day
- **Combined: ~$5/day** for the bulk-crawl window

After comprehensive coverage + 7-day refresh steady state: each region
fires briefly when work is queued, idles otherwise. Estimated **<$1/day**
ongoing.

## Token rotation (Lichess)

Personal API tokens don't expire. If one is compromised or you want to
rotate:

```bash
# Mint new token at lichess.org/account/oauth/token/create
echo -n "<new-token>" | gcloud secrets versions add LICHESS_API_TOKEN_US --data-file=-
# Cloud Run picks up :latest on next execution; in-flight executions
# keep using the old token until they exit.
```

## Out of scope

- **Auto-scaling job count** — fixed 4+2 is enough. Revisit if queue
  growth outpaces drain rate by >2x for >24 hours.
- **Multi-job parallelism within a region** — each region runs one
  task at a time. The watchdog's heartbeat check sees "already
  running" and skips. To run multiple parallel tasks per region,
  bump the watchdog's parallel-task counter.
- **Cross-region failover** — if us-central1 goes down, the EU region
  picks up the slack via the shared queue. No active coordination
  needed.
