// Agents who took calls recently, with full names. Names come from Logto
// (Management API, if an M2M app is configured), falling back to the agent
// name Five9 records with each call, then to the email.
//
// Kept in memory and refreshed in the background, so the agent dropdowns
// never wait on the database after the first load.

const AGENT_LIST_TTL_MS = 10 * 60 * 1000;
const LOGTO_USERS_TTL_MS = 60 * 60 * 1000;
const LOGTO_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15 * 1000;

const titleName = (user) => {
  const name = typeof user.name === 'string' ? user.name.trim() : '';
  if (name) return name;
  const profile = user.profile || {};
  return [profile.givenName, profile.familyName].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()).join(' ');
};

// `query` runs SQL (pool.query); `fetchImpl` and `now` are injectable for tests.
export function createAgentDirectory({ query, env = process.env, fetchImpl = fetch, now = () => Date.now(), log = console } = {}) {
  const endpoint = (env.LOGTO_ENDPOINT || '').replace(/\/+$/, '');
  const m2mId = env.LOGTO_M2M_APP_ID || '';
  const m2mSecret = env.LOGTO_M2M_APP_SECRET || '';
  const managementResource = env.LOGTO_MANAGEMENT_API_RESOURCE || 'https://default.logto.app/api';
  const listDays = parseInt(env.AGENT_LIST_DAYS || '90', 10);
  const logtoConfigured = Boolean(endpoint && m2mId && m2mSecret);

  let agents = null; // [{ email, name, calls }]
  let byEmail = new Map();
  let loadedAt = 0;
  let logtoNames = new Map();
  let logtoAvatars = new Map(); // email -> https avatar URL from Logto (e.g. the Microsoft sign-in picture)
  let logtoLoadedAt = 0;
  let refreshing = null;
  let warnedLogto = false;

  async function fetchJson(url, init) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
    return { json: await res.json(), headers: res.headers };
  }

  async function loadLogtoNames() {
    const { json: token } = await fetchJson(`${endpoint}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${m2mId}:${m2mSecret}`).toString('base64')}`
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', resource: managementResource, scope: 'all' }).toString()
    });
    const names = new Map();
    const avatars = new Map();
    for (let page = 1; ; page++) {
      const { json: users, headers } = await fetchJson(`${endpoint}/api/users?page=${page}&page_size=${LOGTO_PAGE_SIZE}`, {
        headers: { authorization: `Bearer ${token.access_token}` }
      });
      for (const user of users) {
        const email = typeof user.primaryEmail === 'string' ? user.primaryEmail.toLowerCase() : '';
        const name = titleName(user);
        if (email && name) names.set(email, name);
        if (email && typeof user.avatar === 'string' && /^https:\/\//i.test(user.avatar.trim())) avatars.set(email, user.avatar.trim());
      }
      const total = parseInt(headers.get?.('total-number') ?? '', 10);
      if (users.length < LOGTO_PAGE_SIZE || (Number.isFinite(total) && page * LOGTO_PAGE_SIZE >= total)) break;
    }
    return { names, avatars };
  }

  async function refresh() {
    // Agents with calls in the window. reporting is large, so this reads only the
    // timestamp range (idx_reporting_timestamp) and never joins files.
    const cutoff = new Date(now() - listDays * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const { rows } = await query(`
      SELECT lower(agent) AS email, MAX(NULLIF(trim(agent_name), '')) AS five9_name, COUNT(*)::int AS calls
      FROM reporting
      WHERE timestamp >= $1 AND agent LIKE '%@%'
      GROUP BY 1
    `, [cutoff]);

    if (logtoConfigured && now() - logtoLoadedAt > LOGTO_USERS_TTL_MS) {
      try {
        ({ names: logtoNames, avatars: logtoAvatars } = await loadLogtoNames());
        logtoLoadedAt = now();
      } catch (err) {
        // Keep the previous names (if any) and fall back to Five9 for the rest.
        log.warn(`⚠️ [AGENTS] Logto user lookup failed, using Five9 names: ${err.message}`);
        logtoLoadedAt = now() - LOGTO_USERS_TTL_MS + AGENT_LIST_TTL_MS; // retry at the next list refresh
      }
    } else if (!logtoConfigured && !warnedLogto) {
      log.log('ℹ️ [AGENTS] LOGTO_M2M_APP_ID/LOGTO_M2M_APP_SECRET not set; agent names come from Five9 only');
      warnedLogto = true;
    }

    const list = rows.map(r => ({ email: r.email, name: logtoNames.get(r.email) || r.five9_name || r.email, calls: r.calls }))
      .sort((a, b) => a.name.localeCompare(b.name));
    agents = list;
    byEmail = new Map(list.map(a => [a.email, a.name]));
    loadedAt = now();
    const fromLogto = list.filter(a => logtoNames.has(a.email)).length;
    log.log(`👥 [AGENTS] Loaded ${list.length} agents (${fromLogto} names from Logto, ${logtoAvatars.size} Logto users with a photo)`);
    return list;
  }

  // Only one refresh at a time; concurrent callers share it.
  function startRefresh() {
    if (!refreshing) {
      refreshing = refresh().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  return {
    // Waits only for the very first load; afterwards stale data is served while it refreshes.
    async getAgentDirectory() {
      if (!agents) return startRefresh();
      if (now() - loadedAt > AGENT_LIST_TTL_MS) startRefresh().catch(err => log.error('❌ [AGENTS] Refresh failed:', err.message));
      return agents;
    },
    // Display name for one email, or null if the agent isn't in the directory yet.
    agentName(email) {
      if (!email) return null;
      return byEmail.get(String(email).toLowerCase()) || logtoNames.get(String(email).toLowerCase()) || null;
    },
    // The agent's Logto profile photo (an https URL), or null.
    agentAvatar(email) {
      return email ? logtoAvatars.get(String(email).toLowerCase()) || null : null;
    },
    refresh: startRefresh
  };
}
