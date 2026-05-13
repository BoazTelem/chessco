# Deploying `apps/workers` to Cloud Run

**Status (2026-05-13):** runbook ready to execute. `gcloud` is not installed on the dev box yet — install + auth before running the steps below.

This deploys the Inngest serve process from `apps/workers/src/inngest/serve.ts` as a Cloud Run service in europe-west3. The service hosts the FIDE / ICF / ICF-enrichment cron functions. USCF stays disabled until we procure a Cloudflare bypass (see `~/.claude/projects/c--xampp-htdocs-chessco/memory/uscf_cloudflare_verified_block.md`).

## Prerequisites

```bash
# Install gcloud (Windows): https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud config set project <PROJECT_ID>          # use the same project as the games-corpus Cloud SQL
gcloud config set run/region europe-west3

# Enable APIs
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# Create Artifact Registry repo (one-time)
gcloud artifacts repositories create chessco \
  --repository-format=docker \
  --location=europe-west3
```

## 1. Build the worker image

The current `apps/workers/Dockerfile.uscf` is purpose-built for the USCF Playwright job (heavy Chromium base). For the Inngest serve service we want a lean node:20 image. Create `apps/workers/Dockerfile.inngest` from the monorepo root:

```dockerfile
# apps/workers/Dockerfile.inngest
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/workers/package.json ./apps/workers/
COPY packages/db/package.json ./packages/db/
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN pnpm install --filter @chessco/workers... --frozen-lockfile
COPY apps/workers ./apps/workers
COPY packages/db ./packages/db
WORKDIR /app/apps/workers
ENV PORT=8080
CMD ["pnpm", "inngest:serve"]
```

```bash
gcloud builds submit --tag europe-west3-docker.pkg.dev/<PROJECT_ID>/chessco/inngest-worker:latest \
  --file apps/workers/Dockerfile.inngest .
```

## 2. Store the DB URL secret

```bash
printf '%s' "$DATABASE_URL" | gcloud secrets create chessco-db-url --data-file=-
# subsequent rotations:
# printf '%s' "$NEW_URL" | gcloud secrets versions add chessco-db-url --data-file=-
```

## 3. Deploy the service

```bash
gcloud run deploy chessco-inngest-worker \
  --image europe-west3-docker.pkg.dev/<PROJECT_ID>/chessco/inngest-worker:latest \
  --region europe-west3 \
  --platform managed \
  --no-allow-unauthenticated \
  --min-instances 0 \
  --max-instances 2 \
  --memory 1Gi --cpu 1 \
  --timeout 60m \
  --set-env-vars 'NODE_ENV=production' \
  --set-secrets 'DATABASE_URL=chessco-db-url:latest,INNGEST_SIGNING_KEY=chessco-inngest-signing:latest,INNGEST_EVENT_KEY=chessco-inngest-event:latest'
```

The service URL is printed at the end (something like `https://chessco-inngest-worker-xxxx.europe-west3.run.app`). Note it.

Allow Inngest Cloud to call it:

```bash
gcloud run services add-iam-policy-binding chessco-inngest-worker \
  --region europe-west3 \
  --member 'allUsers' \
  --role 'roles/run.invoker'
# (Inngest signs every request with INNGEST_SIGNING_KEY, so unauthenticated invocation
#  is OK at the IAM layer. Don't expose any other route from this service.)
```

## 4. Register with Inngest Cloud

1. Sign in to Inngest Cloud and create a "Chessco Prod" environment.
2. Copy the signing key and event key into Secret Manager (`chessco-inngest-signing`, `chessco-inngest-event`).
3. In Inngest Cloud → Apps → Add app → "URL", paste `https://<service-url>/api/inngest`. Inngest will sync and surface the four registered functions:
   - `fide-monthly-ingest` (cron `0 4 5 * *`)
   - `icf-monthly-ingest` (cron `0 5 6 * *`)
   - `icf-enrichment-daily` (cron `0 4 * * *`)
   - `uscf-monthly-ingest` (cron `0 6 7 * *`) — currently no-op because the Cloud Run job isn't deployed; will fall back to inline and fail at Playwright launch.

## 5. (Skip for now) USCF Cloud Run job

Deferred until we have a Cloudflare bypass solution. When ready:

```bash
gcloud builds submit --tag europe-west3-docker.pkg.dev/<PROJECT_ID>/chessco/uscf-ingest:latest \
  --file apps/workers/Dockerfile.uscf .

gcloud run jobs create chessco-uscf-ingest \
  --image europe-west3-docker.pkg.dev/<PROJECT_ID>/chessco/uscf-ingest:latest \
  --region europe-west3 \
  --task-timeout 60m \
  --memory 2Gi --cpu 2 \
  --set-secrets 'DATABASE_URL=chessco-db-url:latest'

# Grant the Inngest service account roles/run.invoker on this job:
gcloud run jobs add-iam-policy-binding chessco-uscf-ingest \
  --region europe-west3 \
  --member 'serviceAccount:<inngest-worker-sa-email>' \
  --role 'roles/run.invoker'

# Then on the Inngest service:
gcloud run services update chessco-inngest-worker \
  --region europe-west3 \
  --update-env-vars 'USCF_CLOUD_RUN_PROJECT_ID=<PROJECT_ID>,USCF_CLOUD_RUN_REGION=europe-west3,USCF_CLOUD_RUN_JOB_NAME=chessco-uscf-ingest'
```

## Verify

After step 3, the cron functions are scheduled by Inngest Cloud. To force-run one ahead of schedule:

```bash
curl -X POST 'https://api.inngest.com/v1/events' \
  -H "Authorization: Bearer $INNGEST_EVENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"chessco/fide.ingest.requested","data":{}}'
```

Check progress in Inngest Cloud → Runs, and afterwards in Supabase:

```sql
SELECT id, worker, status, started_at, completed_at, metrics
FROM ingestion_runs
ORDER BY started_at DESC
LIMIT 10;
```
