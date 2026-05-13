import { Inngest } from 'inngest';

/**
 * Single Inngest client for the workers app. Functions are registered
 * in sibling modules (`federations.ts`, etc.) and served via
 * `apps/workers/src/inngest/serve.ts`.
 */
export const inngest = new Inngest({
  id: 'chessco-workers',
  name: 'Chessco Workers',
});
