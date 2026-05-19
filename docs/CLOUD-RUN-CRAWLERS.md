# Cloud Run Crawlers — Operational Runbook

Pillar D of the production-scale plan. Four Cloud Run jobs (one chess.com worker per region) each pulling from the shared queue with a distinct egress IP per region. The `crawler-watchdog` Inngest function dispatches them every 15 minutes when work is pending.

> **Lichess is not in scope here.** Lichess bulk corpus updates come from the monthly dump pipeline (`apps/workers/src/lichess-dumps/`), not a Cloud Run crawler. See [LICHESS-CRAWL-RUNBOOK.md](./LICHESS-CRAWL-RUNBOOK.md) and [INCIDENT-2026-05-18-lichess-ip-block.md](./INCIDENT-2026-05-18-lichess-ip-block.md).

## One-time GCP setup

### 1. Build + push the image (once per code change)

From the monorepo root on any machine with `docker` and `gcloud` (or in Google Cloud Shell, which has both):

```bash
gcloud auth configure-docker

docker build -f apps/workers/Dockerfile.chesscom-crawl \
  -t gcr.io/<PROJECT_ID>/chessco-chesscom-crawl:latest .
docker push gcr.io/<PROJECT_ID>/chessco-chesscom-crawl:latest
```

### 2. Stage secrets in Secret Manager

```bash
# Cloud SQL credentials — shared by every region
echo -n "<host>"     | gcloud secrets create GAMES_DB_HOST --data-file=-
echo -n "<port>"     | gcloud secrets create GAMES_DB_PORT --data-file=-
echo -n "<user>"     | gcloud secrets create GAMES_DB_USER --data-file=-
echo -n "<password>" | gcloud secrets create GAMES_DB_PASSWORD --data-file=-
echo -n "<dbname>"   | gcloud secrets create GAMES_DB_NAME --data-file=-
```

Grant the Cloud Run service account `roles/secretmanager.secretAccessor`.

### 3. Create the four Cloud Run jobs

Each region uses the same image + secrets, only `--region` and the per-region env vars differ.

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
```

### 4. Wire env vars into the Inngest serve process

The `inngest:serve` process needs to know which Cloud Run jobs to dispatch. Add these to its environment — the watchdog reads them via `cloudRunJobFromEnv()`:

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
```

`PROJECT_ID` falls back to `GCP_PROJECT_ID` per the existing `cloudRunJobFromEnv` helper — you don't need to repeat it per prefix.

### 5. ADC + IAM

The Inngest serve process needs `roles/run.invoker` on each Cloud Run job (or project-wide). Locally: `gcloud auth application-default login`. In production: bind a service account to the host.

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

Check `chesscom_crawl_runs` for a row with `worker_id='cloud-us'` and recent heartbeat.

### Watchdog smoke

From Inngest dashboard (or via `inngest:dev`), trigger the event `chessco/crawler-watchdog.run.requested`. The function logs each region's decision (`dispatched`, `already-running`, `no-work`, `no-config`). All registered regions with env config + pending work should dispatch.

## Monitoring

```sql
-- Active Cloud Run workers (heartbeats fresh)
SELECT worker_id, items_processed, games_inserted,
       errors, EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at)) AS hb_age_s
FROM chesscom_crawl_runs
WHERE status = 'running' AND last_heartbeat_at > NOW() - INTERVAL '15 minutes'
ORDER BY worker_id;
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

At rest (queue idle, no dispatches): $0/day. Cloud Run jobs bill only during execution.

During active bulk crawl (~7-10 days):

- 4 chess.com instances × 24h × $0.030/h = ~$2.90/day

After comprehensive coverage + 7-day refresh steady state: each region fires briefly when work is queued, idles otherwise. Estimated **<$1/day** ongoing.

## Out of scope

- **Auto-scaling job count** — fixed 4 is enough. Revisit if queue growth outpaces drain rate by >2x for >24 hours.
- **Multi-job parallelism within a region** — each region runs one task at a time. The watchdog's heartbeat check sees "already running" and skips.
- **Cross-region failover** — if us-central1 goes down, another region picks up the slack via the shared queue. No active coordination needed.
- **Lichess** — see [LICHESS-CRAWL-RUNBOOK.md](./LICHESS-CRAWL-RUNBOOK.md). The monthly dumps pipeline is the only sanctioned bulk path for Lichess data.
