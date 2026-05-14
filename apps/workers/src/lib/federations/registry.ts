/**
 * Federation pipeline registry.
 *
 * Each Phase-B wave adds entries here as new federation scrapers ship.
 * The Inngest dispatcher reads this map to know which federations have a
 * runnable pipeline (versus FIDE-slice-fallback-only placeholders).
 *
 * Wave 1 will migrate FIDE/ICF/USCF to use this registry; until then their
 * Inngest functions call the existing `runFideIngest()` / `runIcfIngest()` /
 * `runUscfIngest()` orchestrators directly.
 *
 * NB: do NOT eagerly import scrapers here. Each registry entry is a thunk so
 * that pulling in (e.g.) Playwright happens only when the dispatcher actually
 * runs a Playwright-walled federation.
 */
import type { FederationIngestPipeline } from '../run-federation-ingest.js';

export type PipelineFactory = () => FederationIngestPipeline<unknown>;

/**
 * Internal: write-only mutable map populated at module init. Exposed as a
 * `Map<string, PipelineFactory>` getter so consumers can't accidentally mutate.
 */
const _pipelines = new Map<string, PipelineFactory>();

export function registerPipeline(code: string, factory: PipelineFactory): void {
  if (_pipelines.has(code)) {
    throw new Error(`Pipeline for federation '${code}' is already registered`);
  }
  _pipelines.set(code, factory);
}

export function getPipeline(code: string): PipelineFactory | undefined {
  return _pipelines.get(code);
}

export function listRegisteredFederations(): string[] {
  return Array.from(_pipelines.keys()).sort();
}

// ─── Wave registrations ─────────────────────────────────────────────────────
//
// Add new federations below as Phase-B waves ship. Example for a fetch-html
// federation (Wave 1):
//
//   import { makeEcfPipeline } from '../../ecf/pipeline.js';
//   registerPipeline('ECF', () => makeEcfPipeline());
//
// Wave 0 (already shipped) — FIDE/ICF/USCF currently run their own bespoke
// orchestrators (`runFideIngest`/`runIcfIngest`/`runUscfIngest`). Wave 1 will
// rewrite them as pipelines and register here.
