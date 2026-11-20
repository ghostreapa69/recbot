// Agent profile photos from Microsoft Entra ID (Microsoft Graph), for link previews.
// Needs an Entra app registration with the Microsoft Graph application permission
// User.Read.All (admin-consented): ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET.
const GRAPH = 'https://graph.microsoft.com/v1.0';
const PHOTO_SIZE = '240x240';
const PHOTO_TTL_MS = 6 * 60 * 60 * 1000; // photos (and "no photo") are cached this long
const REQUEST_TIMEOUT_MS = 10 * 1000;

export function createEntraPhotos({ env = process.env, fetchImpl = fetch, now = () => Date.now(), log = console } = {}) {
  const tenant = env.ENTRA_TENANT_ID || '';
  const clientId = env.ENTRA_CLIENT_ID || '';
  const secret = env.ENTRA_CLIENT_SECRET || '';
  const configured = Boolean(tenant && clientId && secret);
  let token = null; // { value, expiresAt }
  const cache = new Map(); // email -> { at, photo: { body, contentType } | null }
  const inFlight = new Map();

  const request = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  async function getToken() {
    if (token && token.expiresAt - 60000 > now()) return token.value;
    const res = await request(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'https://graph.microsoft.com/.default' }).toString()
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`Entra token request failed (HTTP ${res.status}${json.error ? `: ${json.error}` : ''})`);
    token = { value: json.access_token, expiresAt: now() + (Number(json.expires_in) || 3600) * 1000 };
    return token.value;
  }

  async function graphPhoto(userRef, auth) {
    const res = await request(`${GRAPH}/users/${encodeURIComponent(userRef)}/photos/${PHOTO_SIZE}/$value`, { headers: { authorization: `Bearer ${auth}` } });
    if (res.status === 404) return { missing: true };
    if (!res.ok) throw new Error(`Graph photo request failed (HTTP ${res.status})`);
    return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
  }

  async function load(email) {
    const auth = await getToken();
    // The email is usually the user principal name; if not, look the user up by mail.
    let result = await graphPhoto(email, auth);
    if (result.missing) {
      const res = await request(`${GRAPH}/users?$filter=${encodeURIComponent(`mail eq '${email.replace(/'/g, "''")}'`)}&$select=id`, { headers: { authorization: `Bearer ${auth}` } });
      const id = res.ok ? (await res.json()).value?.[0]?.id : null;
      if (id) result = await graphPhoto(id, auth);
    }
    return result.missing ? null : result;
  }

  return {
    configured,
    // { body, contentType } or null when the user has no photo (or Entra isn't configured / fails).
    async photoFor(email) {
      if (!configured || !email) return null;
      const key = email.toLowerCase();
      const hit = cache.get(key);
      if (hit && now() - hit.at < PHOTO_TTL_MS) return hit.photo;
      if (!inFlight.has(key)) {
        inFlight.set(key, load(key)
          .then(photo => { cache.set(key, { at: now(), photo }); return photo; })
          .catch(err => { log.warn(`⚠️ [ENTRA] Photo for ${key} unavailable: ${err.message}`); return null; })
          .finally(() => inFlight.delete(key)));
      }
      return inFlight.get(key);
    }
  };
}
