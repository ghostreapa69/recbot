// Signed agent share links and the link-preview (Open Graph / Slack) tags they unlock.
// Chat apps fetch previews without logging in, so stats only appear for links made with
// the "Copy link" button: signed with a server secret and valid for 30 days.
import crypto from 'crypto';

export const SHARE_LINK_DAYS = 30;
const SECRET_KEY = 'share_link_secret';

const CATEGORY_LABELS = {
  intro: 'Introduction',
  retention: 'Client retention',
  info: 'Information gathered',
  sentiment: 'Client sentiment',
  objection: 'Objection handling',
  control: 'Call control & professionalism'
};

// query: (text, params) => pg result. The secret comes from SHARE_LINK_SECRET, else one is
// generated once and kept in app_state so every container and restart shares it.
export function createShareLinks({ query, envSecret = process.env.SHARE_LINK_SECRET, now = () => Date.now() }) {
  let secretPromise = null;
  const getSecret = () => {
    if (envSecret) return Promise.resolve(envSecret);
    if (!secretPromise) {
      secretPromise = (async () => {
        await query(`INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [SECRET_KEY, crypto.randomBytes(32).toString('hex')]);
        const { rows } = await query(`SELECT value FROM app_state WHERE key = $1`, [SECRET_KEY]);
        return rows[0].value;
      })().catch(err => { secretPromise = null; throw err; });
    }
    return secretPromise;
  };
  const sign = async (agent, exp) => crypto.createHmac('sha256', await getSecret()).update(`${agent}|${exp}`).digest('base64url');

  return {
    // A link to the agent's Home page that previews with stats until it expires.
    async makeLink(baseUrl, agent) {
      const exp = Math.floor(now() / 1000) + SHARE_LINK_DAYS * 24 * 3600;
      const params = new URLSearchParams({ agent, exp: String(exp), sig: await sign(agent, exp) });
      return { url: `${baseUrl}/?${params}`, expiresAt: new Date(exp * 1000).toISOString() };
    },
    async verify(agent, exp, sig) {
      if (typeof agent !== 'string' || typeof exp !== 'string' || typeof sig !== 'string') return false;
      if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now()) return false;
      const expected = Buffer.from(await sign(agent, exp));
      const given = Buffer.from(sig);
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    }
  };
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtScore = n => (n === null || n === undefined || Number.isNaN(Number(n)) ? '–' : `${Number(n) > 0 ? '+' : ''}${Number(n).toFixed(1)}`);
const fmtChange = d => (d === null || Number.isNaN(d) ? '' : `${d >= 0 ? '↑' : '↓'}${Math.abs(d).toFixed(1)}`);

// The preview text for one agent's week, from getAgentDashboard()'s current/previous totals.
export function describeAgentWeek(name, { current = {}, previous = {} }) {
  const avg = current.avg_score;
  const change = avg !== null && avg !== undefined && previous.avg_score !== null && previous.avg_score !== undefined ? avg - previous.avg_score : null;
  const calls = current.calls || 0;
  const scored = current.scored || 0;
  const cats = Object.keys(CATEGORY_LABELS).filter(k => current[k] !== null && current[k] !== undefined).sort((a, b) => current[b] - current[a]);
  const parts = [
    avg === null || avg === undefined
      ? `Last 7 days: ${calls} calls, none scored yet.`
      : `Last 7 days: avg score ${fmtScore(avg)}${change !== null ? ` (${fmtChange(change)} vs prior week)` : ''}, ${calls} calls (${scored} scored).`
  ];
  if (cats.length >= 2) parts.push(`Strongest: ${CATEGORY_LABELS[cats[0]]} ${fmtScore(current[cats[0]])}. Needs work: ${CATEGORY_LABELS[cats[cats.length - 1]]} ${fmtScore(current[cats[cats.length - 1]])}.`);
  return {
    title: `${name} · Agent dashboard`,
    description: parts.join(' '),
    fields: [
      ['Avg score (7 days)', avg === null || avg === undefined ? 'Not scored yet' : `${fmtScore(avg)}${change !== null ? ` ${fmtChange(change)}` : ''}`],
      ['Calls', `${calls} (${scored} scored)`]
    ]
  };
}

export const GENERIC_PREVIEW = { title: 'RecBot', description: 'Call recordings, scores and coaching.', fields: [] };

// Adds Open Graph and Slack (twitter:label/data) tags to the page head and sets <title>.
export function injectPreview(html, { title, description, fields = [] }, url = null) {
  const tags = [
    ['og:site_name', 'RecBot'],
    ['og:type', 'website'],
    ['og:title', title],
    ['og:description', description],
    ...(url ? [['og:url', url]] : []),
    ['twitter:card', 'summary'],
    ['twitter:title', title],
    ['twitter:description', description],
    ...fields.flatMap(([label, data], i) => [[`twitter:label${i + 1}`, label], [`twitter:data${i + 1}`, data]])
  ].map(([key, value]) => `<meta ${key.startsWith('og:') ? 'property' : 'name'}="${key}" content="${escapeHtml(value)}" />`).join('\n    ');
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    .replace(/<\/head>/i, `    ${tags}\n  </head>`);
}
