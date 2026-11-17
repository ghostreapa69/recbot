// How long a token's role is trusted before re-authorizing to pick up role changes.
export const REAUTH_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Whether this page load should bounce through Logto for a fresh-scope token:
// only when the current token carries no RecBot role, or the last
// re-authorization is older than REAUTH_MAX_AGE_MS. (The backend checks the
// role on every request either way.)
export function shouldReauthorize({ role, lastReauthAt, now = Date.now() }) {
  if (!role) return true;
  if (!lastReauthAt || !Number.isFinite(lastReauthAt)) return true;
  return now - lastReauthAt > REAUTH_MAX_AGE_MS;
}
