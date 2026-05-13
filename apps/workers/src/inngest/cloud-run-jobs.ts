/**
 * Cloud Run Jobs dispatcher.
 *
 * Used by federation Inngest functions whose workers can't run in the
 * Inngest process — typically because they need Playwright + Chromium,
 * which is too heavy for the general worker image. The dedicated job
 * image bundles Chromium (see `apps/workers/Dockerfile.uscf`).
 *
 * Auth: relies on Application Default Credentials. In production on GCP
 * the Inngest service has a service account with `roles/run.invoker` on
 * the target job. Locally, run `gcloud auth application-default login`
 * once.
 *
 * Fire-and-forget by design — the job writes its own `ingestion_runs`
 * row, so the cron tick just needs to start the execution and return.
 * If you need synchronous metrics (admin button), `waitForCompletion`
 * polls the operation.
 */
import { GoogleAuth } from 'google-auth-library';

const BASE = 'https://run.googleapis.com/v2';

export type CloudRunJobRef = {
  projectId: string;
  region: string;
  jobName: string;
};

export type DispatchOptions = {
  /** Env vars to overlay on the job container for this execution. */
  envOverrides?: Record<string, string>;
  /** Optional CLI args appended to the container ENTRYPOINT. */
  args?: string[];
};

let cachedAuth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  cachedAuth ??= new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  return cachedAuth;
}

function jobPath(ref: CloudRunJobRef): string {
  return `projects/${ref.projectId}/locations/${ref.region}/jobs/${ref.jobName}`;
}

/**
 * Trigger a single execution of the named Cloud Run job. Returns the
 * long-running operation name (e.g. `projects/.../operations/abc123`).
 * The job writes its own results back to Postgres via `ingestion_runs`.
 */
export async function dispatchCloudRunJob(
  ref: CloudRunJobRef,
  opts: DispatchOptions = {},
): Promise<{ operationName: string }> {
  const client = await getAuth().getClient();
  const url = `${BASE}/${jobPath(ref)}:run`;

  const body: Record<string, unknown> = {};
  if (opts.envOverrides || opts.args) {
    body.overrides = {
      containerOverrides: [
        {
          ...(opts.args ? { args: opts.args } : {}),
          ...(opts.envOverrides
            ? {
                env: Object.entries(opts.envOverrides).map(([name, value]) => ({
                  name,
                  value,
                })),
              }
            : {}),
        },
      ],
    };
  }

  const res = await client.request<{ name: string }>({
    url,
    method: 'POST',
    data: Object.keys(body).length > 0 ? body : undefined,
  });

  return { operationName: res.data.name };
}

/**
 * Resolve a CloudRunJobRef from env vars. Returns null when the env is
 * incomplete so the calling Inngest function can fall back to inline
 * execution (e.g. local dev).
 */
export function cloudRunJobFromEnv(prefix: string): CloudRunJobRef | null {
  const projectId = process.env[`${prefix}_PROJECT_ID`] ?? process.env.GCP_PROJECT_ID;
  const region = process.env[`${prefix}_REGION`] ?? process.env.GCP_REGION;
  const jobName = process.env[`${prefix}_JOB_NAME`];
  if (!projectId || !region || !jobName) return null;
  return { projectId, region, jobName };
}
