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
  const hmac = async payload => crypto.createHmac('sha256', await getSecret()).update(payload).digest('base64url');
  // Agent links sign "agent|exp", call links "call|path|exp". Agent emails may not contain "|",
  // so a signature made for one kind of link can never verify as the other.
  const sign = (agent, exp) => hmac(`${agent}|${exp}`);
  const signCall = (path, exp) => hmac(`call|${path}|${exp}`);
  const expiry = () => Math.floor(now() / 1000) + SHARE_LINK_DAYS * 24 * 3600;
  const checkSig = async (expected, sig) => {
    const a = Buffer.from(await expected);
    const b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const live = exp => typeof exp === 'string' && /^\d+$/.test(exp) && Number(exp) * 1000 >= now();

  return {
    // A link to the agent's Home page that previews with stats until it expires.
    async makeLink(baseUrl, agent) {
      if (agent.includes('|')) throw new Error('Invalid agent');
      const exp = expiry();
      const params = new URLSearchParams({ agent, exp: String(exp), sig: await sign(agent, exp) });
      return { url: `${baseUrl}/?${params}`, expiresAt: new Date(exp * 1000).toISOString() };
    },
    async verify(agent, exp, sig) {
      if (typeof agent !== 'string' || agent.includes('|') || typeof sig !== 'string' || !live(exp)) return false;
      return checkSig(sign(agent, exp), sig);
    },
    // A link to a call page that previews with the call's stats until it expires. It only
    // unlocks the preview text: the recording itself always needs a signed-in session.
    async makeCallLink(baseUrl, path) {
      const exp = expiry();
      const params = new URLSearchParams({ path, exp: String(exp), sig: await signCall(path, exp) });
      return { url: `${baseUrl}/recordings/view?${params}`, expiresAt: new Date(exp * 1000).toISOString() };
    },
    async verifyCall(path, exp, sig) {
      if (typeof path !== 'string' || !path || typeof sig !== 'string' || !live(exp)) return false;
      return checkSig(signCall(path, exp), sig);
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

const formatDuration = ms => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const formatWhen = (date, time) => {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
  const day = d ? `${MONTHS[Number(d[2]) - 1]} ${Number(d[3])}` : '';
  const clock = t ? `${Number(t[1]) % 12 || 12}:${t[2]} ${Number(t[1]) < 12 ? 'AM' : 'PM'}` : '';
  return [day, clock].filter(Boolean).join(', ');
};

// The preview text for one call. Deliberately limited to the agent, when, how long, the
// disposition, scores and the short reason/outcome: no customer name, phone, transcript or audio.
export function describeCall({ agentName, file, disposition, analysis, notScoredReason }) {
  const when = formatWhen(file.call_date, file.call_time);
  const duration = formatDuration(file.duration_ms);
  const scored = analysis && analysis.status === 'completed' && analysis.overall_score !== null && analysis.overall_score !== undefined;
  const details = analysis?.analysis || {};
  const head = [scored ? `Score ${fmtScore(analysis.overall_score)}` : (notScoredReason || 'Not scored yet'), duration, disposition].filter(Boolean).join(' · ');
  const parts = [`${head}.`];
  if (scored && details.callReason) parts.push(`Reason: ${details.callReason}.`);
  if (scored && details.outcome) parts.push(`Outcome: ${details.outcome}.`);
  if (scored) {
    const cats = Object.keys(CATEGORY_LABELS)
      .map(k => [k, analysis[`${k}_score`]])
      .filter(([, v]) => v !== null && v !== undefined)
      .sort((a, b) => b[1] - a[1]);
    if (cats.length >= 2) parts.push(`Strongest: ${CATEGORY_LABELS[cats[0][0]]} ${fmtScore(cats[0][1])}. Needs work: ${CATEGORY_LABELS[cats[cats.length - 1][0]]} ${fmtScore(cats[cats.length - 1][1])}.`);
  }
  return {
    title: ['Call', agentName, when].filter(Boolean).join(' · '),
    description: parts.join(' '),
    fields: [
      ['Call score', scored ? fmtScore(analysis.overall_score) : (notScoredReason || 'Not scored yet')],
      ['Duration', duration]
    ]
  };
}

export const GENERIC_PREVIEW = { title: 'RecBot', description: 'Call recordings, scores and coaching.', fields: [] };

// Adds Open Graph and Slack (twitter:label/data) tags to the page head and sets <title>.
// `image` (an absolute URL) shows as the preview's thumbnail.
export function injectPreview(html, { title, description, fields = [], image = null }, url = null) {
  const tags = [
    ['og:site_name', 'RecBot'],
    ['og:type', 'website'],
    ['og:title', title],
    ['og:description', description],
    ...(url ? [['og:url', url]] : []),
    ...(image ? [['og:image', image], ['og:image:width', '240'], ['og:image:height', '240'], ['og:image:alt', title], ['twitter:image', image]] : []),
    ['twitter:card', 'summary'],
    ['twitter:title', title],
    ['twitter:description', description],
    ...fields.flatMap(([label, data], i) => [[`twitter:label${i + 1}`, label], [`twitter:data${i + 1}`, data]])
  ].map(([key, value]) => `<meta ${key.startsWith('og:') ? 'property' : 'name'}="${key}" content="${escapeHtml(value)}" />`).join('\n    ');
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    .replace(/<\/head>/i, `    ${tags}\n  </head>`);
}
