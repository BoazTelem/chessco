/**
 * Inngest event-sender singleton for the web app.
 *
 * The workers app (`apps/workers/src/inngest/...`) registers handlers that
 * react to events sent from here. In dev the SDK auto-discovers the local
 * Inngest dev server; in prod it reads INNGEST_EVENT_KEY from env and POSTs
 * to inn.gs.
 *
 * Use `sendEvent` (fire-and-forget with logging) from server actions and
 * route handlers so a transient Inngest outage never blocks a user flow
 * like account linking.
 */
import { Inngest, type EventPayload } from 'inngest';

export const inngest = new Inngest({
  id: 'chessco-web',
  name: 'Chessco Web',
});

export async function sendEvent(payload: EventPayload): Promise<void> {
  try {
    await inngest.send(payload);
  } catch (err) {
    console.error('[inngest] send failed', payload.name, err);
  }
}
