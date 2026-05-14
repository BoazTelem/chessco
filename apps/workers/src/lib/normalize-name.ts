/**
 * Canonical re-export of the name-normalization helpers.
 *
 * The original implementation lives in `apps/workers/src/fide/normalize.ts`
 * because FIDE was the first ingest worker. Now that the framework is shared,
 * future federations should `import { normalizeName, pickBestTitle, … } from
 * '../lib/normalize-name.js'` instead of reaching into a sibling worker.
 *
 * Existing imports from `../fide/normalize.js` keep working (no breaking change).
 */
export {
  normalizeName,
  pickBestTitle,
  isImplausibleRating,
  parseBirthYear,
} from '../fide/normalize.js';
