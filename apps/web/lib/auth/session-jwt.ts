/**
 * Extracts the `session_id` claim from a Supabase access token. Supabase
 * stamps every JWT with the uuid of the auth.sessions row that issued it,
 * which is how we identify "which login is this request from?" for the
 * single-active-session enforcement in [[user_active_session migration]].
 *
 * Works in Node (Edge/Server) and the browser — uses atob, which is global
 * in both runtimes.
 */
export function getSessionIdFromJwt(token: string | null | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  const payloadB64u = parts[1];
  if (!payloadB64u) return null;
  try {
    // JWT uses base64url; convert to base64 before atob.
    const b64 = payloadB64u.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { session_id?: unknown };
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}
