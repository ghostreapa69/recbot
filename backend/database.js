import pg from 'pg';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const REPORT_TIMEZONE = process.env.FIVE9_TIMEZONE || 'America/Los_Angeles';
const REPORT_TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ss[Z]';
const REPORT_TIME_DEBUG = /^true$/i.test(process.env.REPORT_TIME_DEBUG || '');
export const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const AUDIT_EXPORT_MAX_ROWS = parsePositiveInt(process.env.AUDIT_EXPORT_MAX_ROWS, 10000);
const REPORT_EXPORT_MAX_ROWS = parsePositiveInt(process.env.REPORT_EXPORT_MAX_ROWS, 5000);
const USER_USAGE_EXPORT_MAX_ROWS = parsePositiveInt(process.env.USER_USAGE_EXPORT_MAX_ROWS, 5000);

// Upper bound on the pagination COUNT(*). Without it a broad filter (a whole
// month with no phone number) counts millions of rows on every page-1 request.
// We count to CAP + 1 so "exactly CAP" is distinguishable from "more than CAP".
const REPORT_COUNT_CAP = parsePositiveInt(process.env.REPORT_COUNT_CAP, 10000);

// Phone numbers arrive from Five9 in whatever shape the carrier sent
// (5551234567, +15551234567, (555) 123-4567), so both the index and the
// predicate normalize to the last 10 digits before comparing.
//
// This expression is the *definition* of idx_reporting_{ani,dnis}_last10.
// Postgres matches an expression index by the parsed expression tree, so it
// must stay in lockstep with what backend/scripts/optimize-reporting-indexes.mjs
// builds — same functions, same arguments, same order. Any drift silently
// disables the index and the seq scans come back.
const phoneLast10Expr = (column) => `right(regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g'), 10)`;

// Below this many digits we can't use the last-10 index and fall back to a
// trigram-backed substring LIKE.
const PHONE_EXACT_MIN_DIGITS = 7;

function phoneDigits(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[^0-9]/g, '');
}

export function normalizeReportTimestamp(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (!trimmed) return null;

  const formatUtc = (dt) => dt && dt.isValid() ? dt.utc().format(REPORT_TIMESTAMP_FORMAT) : null;

  if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] Parsing timestamp="${trimmed}" with REPORT_TIMEZONE="${REPORT_TIMEZONE}"`);

  try {
    if (trimmed.includes('T')) {
      const parsedIso = dayjs(trimmed);
      const normalizedIso = formatUtc(parsedIso);
      if (normalizedIso) {
        if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] ISO parse raw="${trimmed}" -> "${normalizedIso}"`);
        return normalizedIso;
      }
    }

    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
      const parsedSpaceUtc = dayjs.utc(trimmed.replace(' ', 'T') + 'Z');
      const normalizedSpaceUtc = formatUtc(parsedSpaceUtc);
      if (normalizedSpaceUtc) {
        if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] Space parse (assume UTC) raw="${trimmed}" -> "${normalizedSpaceUtc}"`);
        return normalizedSpaceUtc;
      }
      const parsedSpaceTz = dayjs.tz(trimmed, 'YYYY-MM-DD HH:mm:ss', REPORT_TIMEZONE);
      const normalizedSpaceTz = formatUtc(parsedSpaceTz);
      if (normalizedSpaceTz) {
        if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] Space parse (tz fallback ${REPORT_TIMEZONE}) raw="${trimmed}" -> "${normalizedSpaceTz}"`);
        return normalizedSpaceTz;
      }
    }

    const parsedFive9 = dayjs.tz(trimmed, 'ddd, D MMM YYYY HH:mm:ss', REPORT_TIMEZONE);
    if (REPORT_TIME_DEBUG) {
      console.log(`[REPORT_TIME] Five9 format parse: isValid=${parsedFive9.isValid()}, value=${parsedFive9.format()}, utc=${parsedFive9.utc().format()}, offset=${parsedFive9.utcOffset()}`);
    }
    if (parsedFive9.isValid() && parsedFive9.year() > 2000) {
      const normalizedFive9 = formatUtc(parsedFive9);
      if (normalizedFive9) {
        if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] Five9 parse SUCCESS raw="${trimmed}" tz=${REPORT_TIMEZONE} -> "${normalizedFive9}"`);
        return normalizedFive9;
      }
    }

    const fallbackWithTz = dayjs.tz(trimmed, REPORT_TIMEZONE);
    if (fallbackWithTz.isValid()) {
      const normalized = formatUtc(fallbackWithTz);
      if (normalized) {
        if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] Fallback with tz parse SUCCESS raw="${trimmed}" -> "${normalized}"`);
        return normalized;
      }
    }

    const fallback = formatUtc(dayjs(trimmed));
    if (REPORT_TIME_DEBUG && fallback) {
      console.log(`[REPORT_TIME] Last resort parse raw="${trimmed}" -> "${fallback}" (WARNING: no timezone applied)`);
    } else if (REPORT_TIME_DEBUG) {
      console.log(`[REPORT_TIME] All parsing failed for raw="${trimmed}"`);
    }
    return fallback || null;
  } catch (err) {
    if (REPORT_TIME_DEBUG) {
      console.warn(`[REPORT_TIME] Exception normalizing raw="${trimmed}": ${err.message}`);
    }
    return null;
  }
}

// ============================================================
// PostgreSQL Connection Pool
// ============================================================
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'recbot',
  user: process.env.DB_USER || 'recbot',
  password: process.env.DB_PASSWORD || 'recbot',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// Attach an error listener to every pooled client. A checked-out client whose
// connection drops ("Connection terminated unexpectedly") emits an 'error'
// event; without a listener Node treats it as uncaught and CRASHES the process.
// The pool discards the broken connection and opens a new one on the next query.
pool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('PostgreSQL client connection error (handled):', err.message);
  });
});

// Indexes backing the phone filter. On a fresh or small install these build
// instantly, so we create them inline. On an established table they take
// minutes and a plain CREATE INDEX holds a write lock for the duration —
// which would stall the container past its healthcheck start_period — so
// above the threshold we skip and point at the CONCURRENTLY script instead.
const PHONE_INDEX_INLINE_ROW_LIMIT = 100_000;

async function createPhoneSearchIndexes() {
  // reltuples is the planner's estimate, updated by ANALYZE — free to read,
  // no scan. It is -1 on a table that has never been analyzed.
  let estimate = 0;
  try {
    const { rows } = await pool.query(`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'reporting'`);
    estimate = Number(rows[0]?.estimate ?? 0);
  } catch (e) {
    console.warn('[REPORTING] Could not estimate reporting size:', e.message);
  }

  if (estimate > PHONE_INDEX_INLINE_ROW_LIMIT) {
    console.warn(`[REPORTING] Skipping inline phone index creation (~${estimate.toLocaleString('en-US')} rows).`);
    console.warn('[REPORTING] Build them without locking writes by running:');
    console.warn('[REPORTING]   node scripts/optimize-reporting-indexes.mjs');
    return;
  }

  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_ani_last10 ON reporting (${phoneLast10Expr('ani')});`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_dnis_last10 ON reporting (${phoneLast10Expr('dnis')});`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_ani_trgm ON reporting USING gin (ani gin_trgm_ops);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_dnis_trgm ON reporting USING gin (dnis gin_trgm_ops);`);
  } catch (e) {
    // Creating an extension needs superuser on some managed Postgres hosts.
    // Without the indexes phone search still returns correct results, just
    // slowly, so this must not take the app down at boot.
    console.warn('[REPORTING] Phone search index creation failed:', e.message);
    console.warn('[REPORTING] Phone lookups will fall back to sequential scans.');
  }
}

// ============================================================
// Database Initialization (must be called at startup)
// ============================================================
export async function initializeDatabase() {
  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      phone TEXT,
      email TEXT,
      call_date TEXT,
      call_time TEXT,
      call_id TEXT,
      call_disposition TEXT,
      duration_ms INTEGER,
      file_size INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reporting (
      call_id TEXT PRIMARY KEY,
      timestamp TEXT,
      campaign TEXT,
      call_type TEXT,
      agent TEXT,
      agent_name TEXT,
      disposition TEXT,
      ani TEXT,
      customer_name TEXT,
      dnis TEXT,
      call_time INTEGER,
      bill_time_rounded INTEGER,
      cost DOUBLE PRECISION,
      ivr_time INTEGER,
      queue_wait_time INTEGER,
      ring_time INTEGER,
      talk_time INTEGER,
      hold_time INTEGER,
      park_time INTEGER,
      after_call_work_time INTEGER,
      transfers INTEGER,
      conferences INTEGER,
      holds INTEGER,
      abandoned INTEGER,
      recordings TEXT,
      raw_json TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      login_time TIMESTAMP DEFAULT NOW(),
      logout_time TIMESTAMP,
      session_duration_ms INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      last_activity TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      action_type TEXT NOT NULL,
      file_path TEXT,
      file_phone TEXT,
      file_email TEXT,
      call_id TEXT,
      action_timestamp TIMESTAMP DEFAULT NOW(),
      ip_address TEXT,
      user_agent TEXT,
      session_id TEXT,
      additional_data TEXT
    );
  `);

  // Maps a user's stable email to their auth-provider IDs. Used to relink
  // historical logs (originally keyed by Clerk user IDs) to Logto user IDs
  // after the Clerk -> Logto migration. Email is the bridge between providers.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_identity_map (
      email          TEXT PRIMARY KEY,
      clerk_user_id  TEXT,
      logto_user_id  TEXT,
      linked_at      TIMESTAMP DEFAULT NOW()
    );
  `);

  // Favorites, comments and notifications on recordings. Recordings are keyed by
  // file_path (the unique S3 key the API already uses), not files.id, and there
  // are no foreign keys: the SQLite migration script runs
  // TRUNCATE files RESTART IDENTITY, which an FK would block and which renumbers
  // ids. People are keyed by lowercased email, because recording owners and
  // notification recipients only exist as emails (files.email, reporting.agent),
  // and user ids already changed once (Clerk -> Logto).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recording_favorites (
      id SERIAL PRIMARY KEY,
      file_path TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      user_role TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (file_path, user_email)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recording_comments (
      id SERIAL PRIMARY KEY,
      file_path TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      user_role TEXT NOT NULL,
      body TEXT NOT NULL,
      position_ms INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      recipient_email TEXT NOT NULL,
      type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      actor_name TEXT,
      comment_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      read_at TIMESTAMP
    );
  `);

  // AssemblyAI transcripts. Text, utterances and summary are PII-redacted.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      file_path TEXT PRIMARY KEY REFERENCES files(file_path) ON DELETE CASCADE,
      assemblyai_id TEXT,
      status TEXT NOT NULL,
      transcript_text TEXT,
      utterances JSONB,
      summary TEXT,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_transcriptions_status ON transcriptions(status);`);
  // Scriberr replaced AssemblyAI; assemblyai_id stays so older rows remain readable.
  await pool.query(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS scriberr_id TEXT;`);
  await pool.query(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;`);
  // Full-text search over the (already redacted) transcript text.
  await pool.query(`ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(transcript_text, ''))) STORED;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_transcriptions_search ON transcriptions USING gin (search_tsv);`);

  // AI scorecard for each transcribed call. Scores run -10..10; objection_score is
  // NULL when the call had no objection, and overall_score averages the rest.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_analyses (
      file_path TEXT PRIMARY KEY REFERENCES transcriptions(file_path) ON DELETE CASCADE,
      status TEXT NOT NULL,
      model TEXT,
      error TEXT,
      overall_score NUMERIC(4,1),
      intro_score SMALLINT,
      retention_score SMALLINT,
      info_score SMALLINT,
      sentiment_score SMALLINT,
      objection_score SMALLINT,
      control_score SMALLINT,
      analysis JSONB,
      stats JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Set when the agent/customer speaker check has run for this scorecard (older ones are re-checked in the background).
  await pool.query(`ALTER TABLE call_analyses ADD COLUMN IF NOT EXISTS speaker_checked_at TIMESTAMP;`);
  // Failed Claude scoring attempts; status 'retry' until the limit, then 'error'.
  await pool.query(`ALTER TABLE call_analyses ADD COLUMN IF NOT EXISTS attempts SMALLINT NOT NULL DEFAULT 0;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_call_analyses_overall ON call_analyses(overall_score);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_call_analyses_created ON call_analyses(created_at);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_topics (
      file_path TEXT NOT NULL REFERENCES transcriptions(file_path) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (file_path, kind, value)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_call_topics_kind_value ON call_topics(kind, value);`);

  // Manager-only coaching queue. Agents are keyed by lowercased email like the other recording tables.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coaching_items (
      id SERIAL PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      agent_email TEXT,
      created_by TEXT NOT NULL,
      created_by_name TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'to_review',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coaching_items_status ON coaching_items(status);`);

  // Five9 agent groups (synced by five9Teams.js). A supervisor in a group
  // manages the group's other members. Replaced wholesale on each sync.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS five9_users (
      username TEXT PRIMARY KEY,
      email TEXT,
      full_name TEXT,
      is_supervisor BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      synced_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_five9_users_email ON five9_users(email);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS five9_groups (
      name TEXT PRIMARY KEY,
      description TEXT,
      synced_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS five9_group_members (
      group_name TEXT NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (group_name, username)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_five9_group_members_user ON five9_group_members(username);`);

  // Create indexes
  // Migration: add call_disposition column to existing files tables
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS call_disposition TEXT;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_phone ON files(phone);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_email ON files(email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_call_date ON files(call_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_call_time ON files(call_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_duration ON files(duration_ms);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_composite ON files(call_date, phone, email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_call_id ON files(call_id);`);
  // The call's Five9 agent and customer, copied onto the recording by the scan
  // (fillFileAgents) so agent pages can filter on an indexed column instead of
  // joining reporting. Adding nullable columns is instant on any table size.
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS agent_email TEXT;`);
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS agent_name TEXT;`);
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS customer_name TEXT;`);
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS five9_synced_at TIMESTAMP;`);
  // Small key/value store for one-time jobs (e.g. the agent backfill).
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT NOW());`);

  // No DESC twin for idx_reporting_timestamp — a b-tree scans backward natively,
  // so the duplicate only cost write throughput on every ingest batch.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_timestamp ON reporting(timestamp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_agent ON reporting(agent);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_agent_name ON reporting(agent_name);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_campaign ON reporting(campaign);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_call_type ON reporting(call_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_ani ON reporting(ani);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_dnis ON reporting(dnis);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_customer_name ON reporting(customer_name);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_disposition ON reporting(disposition);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_call_disposition ON files(call_disposition);`);

  await createPhoneSearchIndexes();

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_login_time ON user_sessions(login_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_email ON user_sessions(user_email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_last_activity ON user_sessions(last_activity);`);

  // At most one open session per user. A page load fires several API requests
  // at once, and each used to see "no open session", open its own and log a
  // LOGIN; with this index logUserSession() lets exactly one of them win.
  // First close duplicates left by that race — each user keeps the newest and
  // the others end when it began — or the index can't be built.
  await pool.query(`
    WITH ranked AS (
      SELECT id,
             first_value(login_time) OVER newest_first AS kept_login,
             row_number() OVER newest_first AS rn
      FROM user_sessions
      WHERE logout_time IS NULL
      WINDOW newest_first AS (PARTITION BY user_id ORDER BY login_time DESC NULLS LAST, id DESC)
    )
    UPDATE user_sessions s
    SET logout_time = COALESCE(GREATEST(r.kept_login, s.login_time), NOW()),
        session_duration_ms = EXTRACT(EPOCH FROM (COALESCE(GREATEST(r.kept_login, s.login_time), NOW()) - s.login_time)) * 1000
    FROM ranked r
    WHERE s.id = r.id AND r.rn > 1;
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_one_open ON user_sessions(user_id) WHERE logout_time IS NULL;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(action_timestamp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_email ON audit_logs(user_email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_file_path ON audit_logs(file_path);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_composite ON audit_logs(user_id, action_type, action_timestamp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_call_id ON audit_logs(call_id);`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_identity_map_logto ON user_identity_map(logto_user_id);`);

  // recording_favorites' UNIQUE (file_path, user_email) already serves per-recording lookups.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_favorites_user_email ON recording_favorites(user_email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_comments_file_path ON recording_comments(file_path);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_email, id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_file_path ON notifications(file_path);`);

  // Test query
  try {
    const testRow = await pool.query(`SELECT timestamp FROM reporting LIMIT 1`);
    if (testRow.rows.length) {
      console.log(`[REPORTING] Sample timestamp from DB: "${testRow.rows[0].timestamp}"`);
    }
  } catch (e) {
    console.warn('[REPORTING] Datetime test query failed:', e.message);
  }

  console.log('✅ PostgreSQL database initialized');
}

// ============================================================
// File metadata parsing (pure functions, no DB)
// ============================================================
export function parseFileMetadata(filePath) {
  const cleanFile = filePath.startsWith('recordings/') ? filePath.slice('recordings/'.length) : filePath;
  const [folder, filename] = cleanFile.split('/');

  if (!folder || !filename) return null;

  const dateParts = folder.split('_');
  if (dateParts.length !== 3) return null;

  const [month, day, year] = dateParts;
  const callDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

  const phoneMatch = filename.match(/^(\d+)/);
  const phone = phoneMatch ? phoneMatch[1] : '';

  let email = '';
  const emailMatch = filename.match(/by ([^@\s]+@[^\s]+)/);
  if (emailMatch) {
    email = emailMatch[1];
  } else {
    const usernameMatch = filename.match(/by ([^\s]+)/);
    if (usernameMatch) {
      email = usernameMatch[1];
    }
  }

  const timeMatch = filename.match(/@ ([\d_]+ [AP]M)/);
  const timeStr = timeMatch ? timeMatch[1].replace(/_/g, ':') : '';

  let callTime = '';
  if (timeStr) {
    try {
      const parsed = new Date(`1970-01-01 ${timeStr}`);
      if (!isNaN(parsed.getTime())) {
        callTime = parsed.toTimeString().slice(0, 8);
      }
    } catch (e) {
      console.warn('Failed to parse time:', timeStr);
    }
  }

  let callId = null;
  let durationMs = 0;
  let callDisposition = null;
  try {
    // New format: ...@ H_MM_SS AM|PM_duration_callId_dispositionName.wav
    const suffixRegexNew = /@ ([0-9_]+ [AP]M)_(\d+)_(\d+)_([^.]+)\.wav$/;
    const matchNew = filename.match(suffixRegexNew);
    if (matchNew) {
      const rawDuration = matchNew[2];
      const rawCallId = matchNew[3];
      const rawDisposition = matchNew[4];
      if (rawDuration && /^\d+$/.test(rawDuration)) {
        durationMs = parseInt(rawDuration, 10);
      }
      if (rawCallId && /^\d+$/.test(rawCallId)) callId = rawCallId;
      if (rawDisposition) callDisposition = rawDisposition;
    } else {
      // Legacy format: ...@ H_MM_SS AM|PM_duration_callId.wav  or  ...@ H_MM_SS AM|PM_duration.wav
      const suffixRegex = /@ ([0-9_]+ [AP]M)_(\d+)(?:_(\d+))?\.wav$/;
      const match = filename.match(suffixRegex);
      if (match) {
        const rawDuration = match[2];
        const rawCallId = match[3] || null;
        if (rawDuration && /^\d+$/.test(rawDuration)) {
          durationMs = parseInt(rawDuration, 10);
        }
        if (rawCallId && /^\d+$/.test(rawCallId)) callId = rawCallId;
      } else {
        const legacy = filename.match(/@ [0-9_]+ [AP]M_(\d+)\.wav$/);
        if (legacy) {
          const d = parseInt(legacy[1], 10);
          if (!isNaN(d)) durationMs = d;
        }
      }
    }
  } catch (e) {
    console.warn('Filename tail parse error:', e.message, filename);
  }

  return {
    filePath,
    phone,
    email,
    callDate,
    callTime,
    callId,
    callDisposition,
    durationMs,
    fileSize: 0
  };
}

// ============================================================
// File indexing
// ============================================================
export async function indexFile(filePath, fileSize = 0) {
  const metadata = parseFileMetadata(filePath);
  if (!metadata) return false;

  try {
    await pool.query(`
      INSERT INTO files (file_path, phone, email, call_date, call_time, call_id, call_disposition, duration_ms, file_size)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(file_path) DO UPDATE SET
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        call_date = EXCLUDED.call_date,
        call_time = EXCLUDED.call_time,
        call_id = EXCLUDED.call_id,
        call_disposition = EXCLUDED.call_disposition,
        duration_ms = EXCLUDED.duration_ms,
        file_size = EXCLUDED.file_size,
        updated_at = NOW()
    `, [
      metadata.filePath,
      metadata.phone,
      metadata.email,
      metadata.callDate,
      metadata.callTime,
      metadata.callId || null,
      metadata.callDisposition || null,
      metadata.durationMs,
      fileSize
    ]);
    return true;
  } catch (error) {
    console.error('Error indexing file:', filePath, error);
    return false;
  }
}

// Inserts recordings not yet indexed, in one statement per 1,000 files, and
// leaves existing rows untouched. Returns how many were new. Used by the
// 5-minute scan, which used to rewrite every one of the day's rows.
export async function insertNewFiles(filePaths) {
  let inserted = 0;
  for (let i = 0; i < filePaths.length; i += 1000) {
    const batch = filePaths.slice(i, i + 1000).map(parseFileMetadata).filter(Boolean);
    if (!batch.length) continue;
    const { rowCount } = await pool.query(`
      INSERT INTO files (file_path, phone, email, call_date, call_time, call_id, call_disposition, duration_ms, file_size)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::int[])
      ON CONFLICT (file_path) DO NOTHING
    `, [
      batch.map(m => m.filePath), batch.map(m => m.phone), batch.map(m => m.email), batch.map(m => m.callDate),
      batch.map(m => m.callTime), batch.map(m => m.callId || null), batch.map(m => m.callDisposition || null),
      batch.map(m => m.durationMs || 0), batch.map(() => 0)
    ]);
    inserted += rowCount;
  }
  return inserted;
}

// Copies the Five9 agent email/name and customer name onto recordings whose
// call log row has arrived, then falls back to the filename's email for
// recordings with no Five9 match yet. Pass { sinceDate } (YYYY-MM-DD) for the
// scan, or { fromId, toId } for the backfill.
export async function fillFileAgents({ sinceDate = null, fromId = null, toId = null } = {}) {
  const byId = fromId !== null;
  const range = byId ? 'f.id >= $1 AND f.id < $2' : 'f.call_date >= $1';
  const params = byId ? [fromId, toId] : [sinceDate];
  const matched = await pool.query(`
    UPDATE files f SET
      agent_email = lower(r.agent),
      agent_name = COALESCE(NULLIF(trim(r.agent_name), ''), f.agent_name),
      customer_name = COALESCE(NULLIF(trim(r.customer_name), ''), f.customer_name),
      five9_synced_at = NOW()
    FROM reporting r
    WHERE r.call_id = f.call_id AND f.five9_synced_at IS NULL AND r.agent LIKE '%@%' AND ${range}
  `, params);
  const fallback = await pool.query(`
    UPDATE files f SET agent_email = lower(f.email)
    WHERE f.agent_email IS NULL AND f.email LIKE '%@%' AND ${range}
  `, params);
  return { matched: matched.rowCount, fallback: fallback.rowCount };
}

// Recordings added in the last `hours` whose Five9 call log row hasn't arrived.
// `earliest` is when the oldest of those calls started (insert time minus its
// length), as a Date, for the Five9 report window.
export async function getRecentFilesMissingFive9(hours = 6) {
  const { rows: [row] } = await pool.query(`
    SELECT COUNT(*)::int AS count,
      (MIN(f.created_at - make_interval(secs => COALESCE(f.duration_ms, 0) / 1000.0)) AT TIME ZONE current_setting('TimeZone')) AS earliest
    FROM files f
    WHERE f.call_id IS NOT NULL AND f.five9_synced_at IS NULL
      AND f.created_at >= NOW() - make_interval(hours => $1)
      AND NOT EXISTS (SELECT 1 FROM reporting r WHERE r.call_id = f.call_id)
  `, [hours]);
  return row;
}

const FILE_AGENT_BACKFILL_KEY = 'files_agent_backfill_v1';
const FILE_AGENT_BACKFILL_LOCK = 727002;
const FILE_AGENT_BACKFILL_BATCH = 5000;

// One-time job: builds the agent index without locking writes, then fills the
// agent columns for every existing recording in id batches. Only one container
// runs it (advisory lock) and it records completion in app_state. `force`
// re-runs the fill (e.g. after an admin bulk import of older recordings).
export async function runFileAgentBackfill({ force = false } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    ({ rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [FILE_AGENT_BACKFILL_LOCK]));
    if (!locked) return { skipped: 'another container is running it' };

    // An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would keep forever.
    const { rows: invalid } = await client.query(`
      SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_files_agent_email_date' AND NOT i.indisvalid
    `);
    if (invalid.length) await client.query('DROP INDEX CONCURRENTLY IF EXISTS idx_files_agent_email_date');
    const started = Date.now();
    await client.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_agent_email_date ON files (agent_email, call_date)');
    console.log(`👥 [AGENT BACKFILL] Agent index ready (${Date.now() - started}ms)`);

    const { rows: done } = await client.query('SELECT value FROM app_state WHERE key = $1', [FILE_AGENT_BACKFILL_KEY]);
    if (done.length && !force) return { skipped: 'already done' };

    const { rows: [{ min_id: minId, max_id: maxId }] } = await client.query('SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM files');
    let matched = 0;
    let fallback = 0;
    let batches = 0;
    for (let from = Number(minId ?? 0); maxId !== null && from <= Number(maxId); from += FILE_AGENT_BACKFILL_BATCH) {
      const result = await fillFileAgents({ fromId: from, toId: from + FILE_AGENT_BACKFILL_BATCH });
      matched += result.matched;
      fallback += result.fallback;
      if (++batches % 20 === 0) console.log(`👥 [AGENT BACKFILL] Up to id ${from + FILE_AGENT_BACKFILL_BATCH} of ${maxId}: ${matched} matched to Five9, ${fallback} from filename`);
    }
    await client.query('ANALYZE files');
    await client.query(`INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [FILE_AGENT_BACKFILL_KEY, JSON.stringify({ matched, fallback })]);
    console.log(`✅ [AGENT BACKFILL] Done in ${Math.round((Date.now() - started) / 1000)}s: ${matched} matched to Five9, ${fallback} from filename`);
    return { matched, fallback };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [FILE_AGENT_BACKFILL_LOCK]).catch(() => {});
    client.release();
  }
}

export async function backfillFileMetadata(batchSize = 500) {
  let processed = 0;
  let updated = 0;
  for (;;) {
    const { rows } = await pool.query(`
      SELECT file_path FROM files
      WHERE (call_id IS NULL OR call_id = '')
         OR (duration_ms IS NULL OR duration_ms = 0)
         OR (call_disposition IS NULL OR call_disposition = '')
      LIMIT $1
    `, [batchSize]);
    if (!rows.length) break;
    for (const row of rows) {
      processed++;
      const meta = parseFileMetadata(row.file_path);
      if (!meta) continue;
      try {
        await pool.query(`
          UPDATE files SET call_id = $1, duration_ms = $2, call_disposition = $3, updated_at = NOW()
          WHERE file_path = $4
        `, [meta.callId || null, meta.durationMs || 0, meta.callDisposition || null, row.file_path]);
        updated++;
      } catch (e) {
        console.warn('Backfill update failed for', row.file_path, e.message);
      }
    }
    if (rows.length < batchSize) break;
  }
  return { processed, updated };
}

export async function backfillAuditLogCallIds(batchSize = 500) {
  let processed = 0;
  let updated = 0;
  for (;;) {
    const { rows } = await pool.query(`
      SELECT id, additional_data FROM audit_logs
      WHERE call_id IS NULL
        AND additional_data IS NOT NULL
        AND (additional_data LIKE '%callId%' OR additional_data LIKE '%call_id%')
      LIMIT $1
    `, [batchSize]);
    if (!rows.length) break;
    for (const row of rows) {
      processed++;
      if (!row.additional_data) continue;
      try {
        const meta = JSON.parse(row.additional_data);
        const candidate = meta.callId || meta.call_id || null;
        if (candidate && /^\d+$/.test(String(candidate))) {
          await pool.query(`UPDATE audit_logs SET call_id = $1 WHERE id = $2`, [String(candidate), row.id]);
          updated++;
        }
      } catch (e) {
        // ignore JSON parse errors
      }
    }
    if (rows.length < batchSize) break;
  }
  return { processed, updated };
}

export async function indexFiles(files) {
  const client = await pool.connect();
  let failed;
  try {
    await client.query('BEGIN');
    let indexed = 0;
    for (const file of files) {
      const filePath = typeof file === 'string' ? file : file.filePath;
      const fileSize = typeof file === 'object' ? file.fileSize : 0;
      const metadata = parseFileMetadata(filePath);
      if (!metadata) continue;
      try {
        await client.query(`
          INSERT INTO files (file_path, phone, email, call_date, call_time, call_id, call_disposition, duration_ms, file_size)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT(file_path) DO UPDATE SET
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            call_date = EXCLUDED.call_date,
            call_time = EXCLUDED.call_time,
            call_id = EXCLUDED.call_id,
            call_disposition = EXCLUDED.call_disposition,
            duration_ms = EXCLUDED.duration_ms,
            file_size = EXCLUDED.file_size,
            updated_at = NOW()
        `, [
          metadata.filePath,
          metadata.phone,
          metadata.email,
          metadata.callDate,
          metadata.callTime,
          metadata.callId || null,
          metadata.callDisposition || null,
          metadata.durationMs,
          fileSize
        ]);
        indexed++;
      } catch (e) {
        // skip individual errors
      }
    }
    await client.query('COMMIT');
    return indexed;
  } catch (error) {
    failed = error;
    try { await client.query('ROLLBACK'); } catch (e) { /* connection may be gone */ }
    console.error('Error in indexFiles transaction:', error.message);
    return 0;
  } finally {
    try { client.release(failed); } catch (e) { /* already released */ }
  }
}

// ============================================================
// File queries
// ============================================================

// A user owns a recording when their sign-in email is the call's agent:
// files.agent_email, which the recording scan fills from the call's Five9
// reporting row (else from the email in legacy filenames). Served by
// idx_files_agent_email_date. `emailParam` must bind a lowercased email.
const ownedBySql = (emailParam) => `f.agent_email = ${emailParam}`;

export async function queryFiles(filters = {}) {
  const {
    dateStart,
    dateEnd,
    phone,
    email,
    durationMin,
    durationMax,
    hasTranscript,
    timeStart,
    timeEnd,
    callId,
    callDisposition,
    recordingPath,
    scoreMax,
    favorites,
    mine,
    agentEmails,
    viewerEmail,
    sortColumn = 'date',
    sortDirection = 'desc',
    limit = 25,
    offset = 0
  } = filters;

  const startDate = dateStart ? convertDateFormat(dateStart) : null;
  const endDate = dateEnd ? convertDateFormat(dateEnd) : null;

  // Build WHERE clause dynamically
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (startDate) { conditions.push(`call_date >= $${paramIdx++}`); params.push(startDate); }
  if (endDate) { conditions.push(`call_date <= $${paramIdx++}`); params.push(endDate); }
  if (phone) { conditions.push(`phone LIKE '%' || $${paramIdx++} || '%'`); params.push(phone); }
  if (email) { conditions.push(`email LIKE '%' || $${paramIdx++} || '%'`); params.push(email); }
  if (durationMin) { conditions.push(`duration_ms >= $${paramIdx++} * 1000`); params.push(durationMin); }
  if (durationMax) { conditions.push(`duration_ms <= $${paramIdx++} * 1000`); params.push(durationMax); }
  // A finished transcript; in-progress and failed ones count as "no transcript".
  if (hasTranscript === '1' || hasTranscript === '0') {
    conditions.push(`${hasTranscript === '0' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM transcriptions t WHERE t.file_path = f.file_path AND t.status = 'completed')`);
  }
  if (timeStart) { conditions.push(`call_time >= $${paramIdx++}`); params.push(timeStart); }
  if (timeEnd) { conditions.push(`call_time <= $${paramIdx++}`); params.push(timeEnd); }
  if (callId) { conditions.push(`call_id LIKE '%' || $${paramIdx++} || '%'`); params.push(callId); }
  if (callDisposition) { conditions.push(`call_disposition = $${paramIdx++}`); params.push(callDisposition); }
  if (recordingPath) { conditions.push(`f.file_path = $${paramIdx++}`); params.push(recordingPath); }
  if (scoreMax !== undefined && scoreMax !== null && scoreMax !== '' && Number.isFinite(Number(scoreMax))) {
    conditions.push(`EXISTS (SELECT 1 FROM call_analyses ca WHERE ca.file_path = f.file_path AND ca.overall_score <= $${paramIdx++})`);
    params.push(Number(scoreMax));
  }
  if (favorites === 'mine') {
    conditions.push(`EXISTS (SELECT 1 FROM recording_favorites rf WHERE rf.file_path = f.file_path AND rf.user_email = $${paramIdx++})`);
    params.push(viewerEmail || null);
  } else if (favorites === 'any') {
    conditions.push(`EXISTS (SELECT 1 FROM recording_favorites rf WHERE rf.file_path = f.file_path)`);
  }
  if (mine) { conditions.push(ownedBySql(`$${paramIdx++}`)); params.push(viewerEmail || null); }
  // A manager's team (an empty team matches nothing).
  if (Array.isArray(agentEmails)) { conditions.push(`f.agent_email = ANY($${paramIdx++}::text[])`); params.push(agentEmails); }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  // The count query binds exactly these; Postgres rejects unused bind values.
  const whereParamCount = params.length;

  // Build ORDER BY
  const sortMap = {
    date: 'call_date',
    time: 'call_time',
    phone: 'phone',
    email: 'email',
    durationMs: 'duration_ms',
    callId: 'call_id',
    callDisposition: 'call_disposition',
    favoriteCount: 'favorite_count',
    score: 'overall_score'
  };
  const sortCol = sortMap[sortColumn] || 'call_date';
  const sortDir = sortDirection === 'asc' ? 'ASC' : 'DESC';
  // Unscored calls sort after scored ones in either direction.
  const orderBy = `ORDER BY ${sortCol} ${sortDir}${sortCol === 'overall_score' ? ' NULLS LAST' : ''}, call_date DESC, call_time DESC`;

  // Per-viewer columns, bound after the WHERE params so only the data query uses them.
  const viewerParam = `$${paramIdx++}`;
  params.push(viewerEmail || null);
  const limitParam = `$${paramIdx++}`;
  const offsetParam = `$${paramIdx++}`;
  params.push(limit, offset);

  // The subqueries run only for the returned page: with a LIMIT, Postgres
  // evaluates expensive select-list expressions after the sort (unless one is
  // the sort key, as favorite_count is for "Most favorited").
  const dataQuery = `
    SELECT file_path, phone, email, call_date, call_time, call_id, call_disposition, duration_ms, file_size,
      agent_email, agent_name, customer_name,
      (SELECT COUNT(*) FROM recording_favorites rf WHERE rf.file_path = f.file_path)::int AS favorite_count,
      (SELECT COUNT(*) FROM recording_comments rc WHERE rc.file_path = f.file_path)::int AS comment_count,
      (SELECT ca.overall_score FROM call_analyses ca WHERE ca.file_path = f.file_path AND ca.status = 'completed')::float AS overall_score,
      EXISTS (SELECT 1 FROM recording_favorites rf WHERE rf.file_path = f.file_path AND rf.user_email = ${viewerParam}) AS favorited_by_me,
      ${ownedBySql(viewerParam)} AS is_mine
    FROM files f ${whereClause}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  // Count query (same conditions, no limit/offset)
  const countParams = params.slice(0, whereParamCount);
  const countQuery = `SELECT COUNT(*) as total FROM files f ${whereClause}`;

  const [dataResult, countResult] = await Promise.all([
    pool.query(dataQuery, params),
    pool.query(countQuery, countParams)
  ]);

  const total = parseInt(countResult.rows[0].total, 10);

  return {
    files: dataResult.rows.map(f => ({
      file_path: f.file_path,
      phone: f.phone,
      email: f.email,
      call_date: f.call_date,
      call_time: f.call_time,
      call_id: f.call_id || null,
      call_disposition: f.call_disposition || null,
      duration_ms: f.duration_ms,
      file_size: f.file_size,
      favorite_count: f.favorite_count,
      comment_count: f.comment_count,
      favorited_by_me: f.favorited_by_me,
      overall_score: f.overall_score ?? null,
      agent_email: f.agent_email || null,
      agent_name: f.agent_name || null,
      customer_name: f.customer_name || null,
      // NULL when files.email is NULL and no reporting row matches.
      is_mine: f.is_mine === true
    })),
    totalCount: total,
    hasMore: offset + limit < total
  };
}

function convertDateFormat(dateStr) {
  if (!dateStr) return null;
  if (dateStr.includes('_')) {
    const [month, day, year] = dateStr.split('_');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return dateStr;
}

// ============================================================
// Database Stats
// ============================================================
export async function getDatabaseStats() {
  try {
    const result = await pool.query('SELECT COUNT(*) as total FROM files');
    const total = parseInt(result.rows[0].total, 10);
    return {
      totalFiles: total || 0,
      databasePath: `postgresql://${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'recbot'}`,
      databaseSize: 0
    };
  } catch (error) {
    console.error('Error getting database stats:', error);
    return { totalFiles: 0, databasePath: 'postgresql', databaseSize: 0 };
  }
}

// ============================================================
// Auth identity linking (Clerk -> Logto migration)
// ============================================================
// Called on each authenticated request. The first time a given email is seen
// under a Logto user ID, it rewrites that user's historical log rows (which
// were keyed by their old Clerk `user_xxx` ID) to the Logto ID, using email as
// the bridge. Idempotent: once linked, subsequent calls short-circuit cheaply
// so this does not scan the log tables on every request.
// Look up a user's email by their Logto user ID via the identity map (populated
// on a prior header-authenticated login). Used to authenticate requests that
// can't send the ID token header — e.g. native <audio> ?auth= stream URLs.
export async function getEmailByLogtoId(logtoUserId) {
  if (!logtoUserId) return null;
  try {
    const r = await pool.query(
      `SELECT email FROM user_identity_map WHERE logto_user_id = $1 LIMIT 1`,
      [logtoUserId]
    );
    return r.rows.length ? r.rows[0].email : null;
  } catch (e) {
    console.error('getEmailByLogtoId failed:', e.message);
    return null;
  }
}

// In-memory cache of (logtoUserId, email) pairs already linked in this process,
// so linkLogtoIdentity does NOT touch the DB on every authenticated request
// (which otherwise contends for pool connections and can exhaust it).
const linkedIdentityCache = new Set();

export async function linkLogtoIdentity(logtoUserId, email) {
  if (!logtoUserId || !email) return { linked: false, reason: 'missing_args' };

  const cacheKey = `${logtoUserId} ${email.toLowerCase()}`;
  if (linkedIdentityCache.has(cacheKey)) {
    return { linked: false, reason: 'cached' };
  }

  // Fast path (the common case after a user's first login): if this email is
  // already mapped to this Logto ID, do nothing. Uses pool.query so we don't
  // check out a manual client or open a transaction on every request.
  try {
    const existing = await pool.query(
      `SELECT logto_user_id FROM user_identity_map WHERE email = $1`,
      [email]
    );
    if (existing.rows.length && existing.rows[0].logto_user_id === logtoUserId) {
      linkedIdentityCache.add(cacheKey);
      return { linked: false, reason: 'already_linked' };
    }
  } catch (e) {
    console.error('Identity link: lookup failed:', e.message);
    return { linked: false, reason: 'error', error: e.message };
  }

  let client;
  try {
    client = await pool.connect();
  } catch (e) {
    // Could not get a connection (pool exhausted / DB down). Don't crash — the
    // relink is best-effort and idempotent, so it retries on the next request.
    console.error('Identity link: could not acquire DB client:', e.message);
    return { linked: false, reason: 'no_client' };
  }

  // A checked-out client whose connection drops emits an 'error' event. Without
  // this listener that becomes an unhandled error and crashes the process.
  client.on('error', (e) => {
    console.error('Identity link: pg client connection error:', e.message);
  });

  let failed;
  try {
    await client.query('BEGIN');

    // Already linked to this exact Logto ID? Nothing to do.
    const existing = await client.query(
      `SELECT logto_user_id FROM user_identity_map WHERE email = $1`,
      [email]
    );
    if (existing.rows.length && existing.rows[0].logto_user_id === logtoUserId) {
      await client.query('COMMIT');
      return { linked: false, reason: 'already_linked' };
    }

    // Capture the prior (e.g. Clerk) ID we're relinking from, for the audit trail.
    const prior = await client.query(
      `SELECT user_id FROM user_sessions WHERE user_email = $1 AND user_id <> $2
       UNION
       SELECT user_id FROM audit_logs   WHERE user_email = $1 AND user_id <> $2
       LIMIT 1`,
      [email, logtoUserId]
    );
    const clerkUserId = prior.rows.length ? prior.rows[0].user_id : null;

    // Rewrite historical logs from the old ID to the Logto ID.
    const sessions = await client.query(
      `UPDATE user_sessions SET user_id = $1 WHERE user_email = $2 AND user_id <> $1`,
      [logtoUserId, email]
    );
    const audits = await client.query(
      `UPDATE audit_logs SET user_id = $1 WHERE user_email = $2 AND user_id <> $1`,
      [logtoUserId, email]
    );

    await client.query(
      `INSERT INTO user_identity_map (email, clerk_user_id, logto_user_id, linked_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (email) DO UPDATE
         SET logto_user_id = EXCLUDED.logto_user_id,
             clerk_user_id = COALESCE(user_identity_map.clerk_user_id, EXCLUDED.clerk_user_id),
             linked_at = NOW()`,
      [email, clerkUserId, logtoUserId]
    );

    await client.query('COMMIT');
    linkedIdentityCache.add(cacheKey);

    const relinked = (sessions.rowCount || 0) + (audits.rowCount || 0);
    if (relinked > 0) {
      console.log(`🔗 [IDENTITY] Linked ${email} -> ${logtoUserId} (relinked ${sessions.rowCount} session rows, ${audits.rowCount} audit rows from ${clerkUserId || 'n/a'})`);
    }
    return {
      linked: true,
      relinkedSessions: sessions.rowCount || 0,
      relinkedAudit: audits.rowCount || 0,
      clerkUserId
    };
  } catch (error) {
    failed = error;
    // The connection may already be dead; don't let a failing ROLLBACK throw.
    try { await client.query('ROLLBACK'); } catch (e) { /* connection gone */ }
    console.error('Error linking Logto identity:', error.message);
    return { linked: false, reason: 'error', error: error.message };
  } finally {
    // Passing the error to release() discards a possibly-broken connection
    // instead of returning it to the pool.
    try { client.release(failed); } catch (e) { /* already released */ }
  }
}

// ============================================================
// Audit logging
// ============================================================
// Opens a session unless the user already has an open one. Concurrent requests
// race here and idx_user_sessions_one_open lets exactly one insert. Returns the
// new session's id, or null when another request opened it first (or on
// error) — callers log a LOGIN only when they get an id.
export async function logUserSession(userId, userEmail, ipAddress, userAgent) {
  try {
    const result = await pool.query(`
      INSERT INTO user_sessions (user_id, user_email, ip_address, user_agent, last_activity)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) WHERE logout_time IS NULL DO NOTHING
      RETURNING id
    `, [userId, userEmail, ipAddress, userAgent]);
    if (!result.rows.length) return null;
    console.log(`📋 [AUDIT] User session created for ${userEmail} (ID: ${userId})`);
    return result.rows[0].id;
  } catch (error) {
    console.error('Error creating user session:', error);
    return null;
  }
}

export async function getOpenSessionId(userId) {
  try {
    const { rows } = await pool.query(`SELECT id FROM user_sessions WHERE user_id = $1 AND logout_time IS NULL`, [userId]);
    return rows.length ? rows[0].id : null;
  } catch (error) {
    console.error('Error getting open session:', error);
    return null;
  }
}

// Closes one specific session. Returns true only for the call that actually
// closed it, so concurrent requests expiring the same session log one LOGOUT.
export async function closeUserSession(sessionId) {
  try {
    const { rowCount } = await pool.query(`
      UPDATE user_sessions
      SET logout_time = NOW(),
          session_duration_ms = EXTRACT(EPOCH FROM (NOW() - login_time)) * 1000
      WHERE id = $1 AND logout_time IS NULL
    `, [sessionId]);
    return rowCount > 0;
  } catch (error) {
    console.error('Error closing user session:', error);
    return false;
  }
}

export async function logUserLogout(userId) {
  try {
    await pool.query(`
      UPDATE user_sessions
      SET logout_time = NOW(),
          session_duration_ms = EXTRACT(EPOCH FROM (NOW() - login_time)) * 1000
      WHERE user_id = $1 AND logout_time IS NULL
    `, [userId]);
    console.log(`📋 [AUDIT] User session ended for ${userId}`);
  } catch (error) {
    console.error('Error updating user session:', error);
  }
}

export async function touchUserSession(userId) {
  try {
    await pool.query(`
      UPDATE user_sessions SET last_activity = NOW()
      WHERE user_id = $1 AND logout_time IS NULL
    `, [userId]);
  } catch (error) {
    console.error('Error updating session activity:', error);
  }
}

export async function expireStaleSessions(maxHours = 4, batchLimit = 100) {
  try {
    const { rows } = await pool.query(`
      SELECT id, user_id, user_email, login_time, ip_address, user_agent
      FROM user_sessions
      WHERE logout_time IS NULL
        AND EXTRACT(EPOCH FROM (NOW() - login_time)) > ($1 * 3600)
      LIMIT $2
    `, [maxHours, batchLimit]);
    if (!rows.length) return 0;
    for (const row of rows) {
      await pool.query(`
        UPDATE user_sessions
        SET logout_time = NOW(),
            session_duration_ms = EXTRACT(EPOCH FROM (NOW() - login_time)) * 1000
        WHERE id = $1 AND logout_time IS NULL
      `, [row.id]);
    }
    return rows;
  } catch (e) {
    console.error('Error expiring sessions:', e);
    return 0;
  }
}

export async function expireInactiveSessions(maxInactivityMinutes = 30, batchLimit = 200) {
  try {
    const { rows } = await pool.query(`
      SELECT id, user_id, user_email, login_time, last_activity, ip_address, user_agent
      FROM user_sessions
      WHERE logout_time IS NULL
        AND last_activity IS NOT NULL
        AND EXTRACT(EPOCH FROM (NOW() - last_activity)) > ($1 * 60)
      LIMIT $2
    `, [maxInactivityMinutes, batchLimit]);
    if (!rows.length) return 0;
    for (const row of rows) {
      await pool.query(`
        UPDATE user_sessions
        SET logout_time = NOW(),
            session_duration_ms = EXTRACT(EPOCH FROM (NOW() - login_time)) * 1000
        WHERE id = $1 AND logout_time IS NULL
      `, [row.id]);
    }
    return rows;
  } catch (e) {
    console.error('Error expiring inactive sessions:', e);
    return 0;
  }
}

export async function repairOpenSessions({ keepLatestOpen = true } = {}) {
  try {
    const { rows: open } = await pool.query(`
      SELECT id, user_id, user_email, login_time, last_activity
      FROM user_sessions
      WHERE logout_time IS NULL
      ORDER BY user_id, login_time ASC, id ASC
    `);
    if (!open.length) return { usersAffected: 0, sessionsClosed: 0, details: [] };

    const byUser = new Map();
    open.forEach(s => {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
      byUser.get(s.user_id).push(s);
    });

    const details = [];
    let sessionsClosed = 0;
    for (const [userId, sessions] of byUser.entries()) {
      if (sessions.length <= 1) continue;
      for (let i = 0; i < sessions.length; i++) {
        const sess = sessions[i];
        const next = sessions[i + 1];
        const isLast = i === sessions.length - 1;
        if (isLast && keepLatestOpen) continue;
        let logoutTime = next ? new Date(next.login_time).toISOString() : new Date().toISOString();
        if (new Date(logoutTime).getTime() <= new Date(sess.login_time).getTime()) {
          logoutTime = new Date(new Date(sess.login_time).getTime() + 1000).toISOString();
        }
        await pool.query(`
          UPDATE user_sessions
          SET logout_time = $1,
              session_duration_ms = EXTRACT(EPOCH FROM ($1::timestamp - login_time)) * 1000
          WHERE id = $2 AND logout_time IS NULL
        `, [logoutTime, sess.id]);
        sessionsClosed++;
        details.push({ sessionId: sess.id, userId, closedAt: logoutTime, login_time: sess.login_time });
      }
    }
    return {
      usersAffected: details.reduce((acc, d) => { acc.add(d.userId); return acc; }, new Set()).size,
      sessionsClosed,
      details
    };
  } catch (e) {
    console.error('Error repairing sessions:', e);
    return { usersAffected: 0, sessionsClosed: 0, details: [], error: e.message };
  }
}

export async function backfillExpiredOpenSessions(maxHours = 4) {
  try {
    const { rows } = await pool.query(`
      SELECT id, user_id, user_email, login_time
      FROM user_sessions
      WHERE logout_time IS NULL
        AND EXTRACT(EPOCH FROM (NOW() - login_time)) > ($1 * 3600)
      ORDER BY login_time ASC
    `, [maxHours]);
    if (!rows.length) return { closed: 0, details: [] };

    const details = [];
    for (const row of rows) {
      const syntheticLogout = new Date(new Date(row.login_time).getTime() + maxHours * 3600 * 1000).toISOString();
      const nowIso = new Date().toISOString();
      const finalLogout = syntheticLogout > nowIso ? nowIso : syntheticLogout;
      await pool.query(`
        UPDATE user_sessions
        SET logout_time = $1,
            session_duration_ms = EXTRACT(EPOCH FROM ($1::timestamp - login_time)) * 1000
        WHERE id = $2 AND logout_time IS NULL
      `, [finalLogout, row.id]);
      details.push({ sessionId: row.id, userId: row.user_id, login_time: row.login_time, logout_time: finalLogout });
    }
    return { closed: details.length, details };
  } catch (e) {
    console.error('Error backfilling expired open sessions:', e);
    return { closed: 0, details: [], error: e.message };
  }
}

export async function logAuditEvent(userId, userEmail, actionType, filePath = null, fileMetadata = null, ipAddress = null, userAgent = null, sessionId = null, additionalData = null) {
  try {
    const filePhone = fileMetadata?.phone || null;
    const fileEmail = fileMetadata?.email || null;
    const additionalDataStr = additionalData ? JSON.stringify(additionalData) : null;
    const callId = fileMetadata?.callId || fileMetadata?.call_id || additionalData?.callId || null;

    await pool.query(`
      INSERT INTO audit_logs (user_id, user_email, action_type, file_path, file_phone, file_email, call_id,
                             ip_address, user_agent, session_id, additional_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [userId, userEmail, actionType, filePath, filePhone, fileEmail, callId, ipAddress, userAgent, sessionId, additionalDataStr]);

    console.log(`📋 [AUDIT] ${actionType} logged for ${userEmail}${filePath ? ` - File: ${filePath}` : ''}`);
  } catch (error) {
    console.error('Error creating audit log:', error);
  }
}

export async function getAuditLogs(userId = null, actionType = null, startDate = null, endDate = null, callId = null, limit = 100, offset = 0) {
  try {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (userId) { conditions.push(`user_id = $${paramIdx++}`); params.push(userId); }
    if (actionType) { conditions.push(`action_type = $${paramIdx++}`); params.push(actionType); }
    if (startDate) { conditions.push(`DATE(action_timestamp) >= $${paramIdx++}`); params.push(startDate); }
    if (endDate) { conditions.push(`DATE(action_timestamp) <= $${paramIdx++}`); params.push(endDate); }
    if (callId) { conditions.push(`call_id LIKE '%' || $${paramIdx++} || '%'`); params.push(callId); }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countParams = [...params];
    const dataParams = [...params];
    dataParams.push(limit, offset);

    const countQuery = `SELECT COUNT(*) as total FROM audit_logs ${whereClause}`;
    const dataQuery = `SELECT * FROM audit_logs ${whereClause} ORDER BY action_timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      pool.query(countQuery, countParams)
    ]);

    return { rows: dataResult.rows, total: parseInt(countResult.rows[0].total, 10) };
  } catch (error) {
    console.error('Error getting audit logs:', error);
    return { rows: [], total: 0 };
  }
}

export async function getCallIdsWithRecordings(callIds = []) {
  if (!Array.isArray(callIds) || !callIds.length) return {};
  const seen = new Set();
  const unique = [];
  for (const id of callIds) {
    if (!id) continue;
    const key = String(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  if (!unique.length) return {};

  const result = {};
  const MAX_PARAMS = 999;

  for (let i = 0; i < unique.length; i += MAX_PARAMS) {
    const chunk = unique.slice(i, i + MAX_PARAMS);
    if (!chunk.length) continue;
    const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
    try {
      const { rows } = await pool.query(`SELECT DISTINCT call_id FROM files WHERE call_id IN (${placeholders})`, chunk);
      for (const row of rows) {
        if (row?.call_id) result[row.call_id] = true;
      }
    } catch (err) {
      console.warn('[DB] getCallIdsWithRecordings query failed:', err.message);
    }
  }
  return result;
}

export async function exportAuditLogs(filters = {}, maxRows = AUDIT_EXPORT_MAX_ROWS) {
  const { userId = null, actionType = null, startDate = null, endDate = null, callId = null } = filters;

  try {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (userId) { conditions.push(`user_id = $${paramIdx++}`); params.push(userId); }
    if (actionType) { conditions.push(`action_type = $${paramIdx++}`); params.push(actionType); }
    if (startDate) { conditions.push(`DATE(action_timestamp) >= $${paramIdx++}`); params.push(startDate); }
    if (endDate) { conditions.push(`DATE(action_timestamp) <= $${paramIdx++}`); params.push(endDate); }
    if (callId) { conditions.push(`call_id LIKE '%' || $${paramIdx++} || '%'`); params.push(callId); }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(`SELECT COUNT(*) as total FROM audit_logs ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].total, 10);

    if (total > maxRows) {
      return { rows: [], total, truncated: true, maxRows };
    }

    const dataResult = await pool.query(
      `SELECT * FROM audit_logs ${whereClause} ORDER BY action_timestamp DESC`,
      params
    );

    return { rows: dataResult.rows, total, truncated: false, maxRows };
  } catch (error) {
    console.error('Error exporting audit logs:', error);
    return { rows: [], total: 0, truncated: false, maxRows, error: error.message };
  }
}

export async function getUserSessions(userId = null, startDate = null, endDate = null, limit = 100, offset = 0) {
  try {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (userId) { conditions.push(`user_id = $${paramIdx++}`); params.push(userId); }
    if (startDate) { conditions.push(`DATE(login_time) >= $${paramIdx++}`); params.push(startDate); }
    if (endDate) { conditions.push(`DATE(login_time) <= $${paramIdx++}`); params.push(endDate); }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM user_sessions ${whereClause} ORDER BY login_time DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      params
    );
    return rows;
  } catch (error) {
    console.error('Error getting user sessions:', error);
    return [];
  }
}

export async function getUserUsageReport(startDate = null, endDate = null) {
  try {
    const conditions1 = [];
    const conditions2 = [];
    const params = [];
    let paramIdx = 1;

    if (startDate) {
      conditions1.push(`DATE(action_timestamp) >= $${paramIdx}`);
      conditions2.push(`DATE(login_time) >= $${paramIdx}`);
      params.push(startDate);
      paramIdx++;
    }
    if (endDate) {
      conditions1.push(`DATE(action_timestamp) <= $${paramIdx}`);
      conditions2.push(`DATE(login_time) <= $${paramIdx}`);
      params.push(endDate);
      paramIdx++;
    }

    const auditWhere = conditions1.length ? 'WHERE ' + conditions1.join(' AND ') : '';
    const sessionWhere = conditions2.length ? 'WHERE ' + conditions2.join(' AND ') : '';

    const { rows } = await pool.query(`
      WITH filtered_audit AS (
        SELECT user_id, user_email, action_type, action_timestamp
        FROM audit_logs ${auditWhere}
      ),
      audit_counts AS (
        SELECT
          user_id,
          COALESCE(MAX(user_email), '') AS user_email,
          COUNT(*) AS total_actions,
          SUM(CASE WHEN action_type = 'LOGIN' THEN 1 ELSE 0 END) AS login_count,
          SUM(CASE WHEN action_type = 'LOGOUT' THEN 1 ELSE 0 END) AS logout_count,
          SUM(CASE WHEN action_type = 'PLAY_FILE' THEN 1 ELSE 0 END) AS play_count,
          SUM(CASE WHEN action_type = 'DOWNLOAD_FILE' THEN 1 ELSE 0 END) AS download_count,
          SUM(CASE WHEN action_type = 'VIEW_FILES' THEN 1 ELSE 0 END) AS view_count,
          SUM(CASE WHEN action_type = 'REPORT_VIEW' THEN 1 ELSE 0 END) AS report_view_count,
          SUM(CASE WHEN action_type = 'REPORT_DOWNLOAD' THEN 1 ELSE 0 END) AS report_download_count,
          MAX(action_timestamp) AS last_action_at
        FROM filtered_audit
        GROUP BY user_id
      ),
      filtered_sessions AS (
        SELECT user_id, user_email, COALESCE(session_duration_ms, 0) AS session_duration_ms
        FROM user_sessions ${sessionWhere}
      ),
      session_totals AS (
        SELECT
          user_id,
          COALESCE(MAX(user_email), '') AS user_email,
          SUM(session_duration_ms) AS total_session_ms
        FROM filtered_sessions
        GROUP BY user_id
      ),
      combined_users AS (
        SELECT user_id FROM audit_counts
        UNION
        SELECT user_id FROM session_totals
      )
      SELECT
        u.user_id,
        COALESCE(ac.user_email, st.user_email) AS user_email,
        COALESCE(ac.total_actions, 0)::int AS total_actions,
        COALESCE(ac.login_count, 0)::int AS login_count,
        COALESCE(ac.logout_count, 0)::int AS logout_count,
        COALESCE(ac.play_count, 0)::int AS play_count,
        COALESCE(ac.download_count, 0)::int AS download_count,
        COALESCE(ac.view_count, 0)::int AS view_count,
        COALESCE(ac.report_view_count, 0)::int AS report_view_count,
        COALESCE(ac.report_download_count, 0)::int AS report_download_count,
        ac.last_action_at,
        COALESCE(st.total_session_ms, 0)::bigint AS total_session_ms
      FROM combined_users u
      LEFT JOIN audit_counts ac ON ac.user_id = u.user_id
      LEFT JOIN session_totals st ON st.user_id = u.user_id
      ORDER BY LOWER(COALESCE(ac.user_email, st.user_email)), u.user_id
    `, params);

    return rows.map(row => ({
      user_id: row.user_id,
      user_email: row.user_email,
      total_actions: Number(row.total_actions) || 0,
      login_count: Number(row.login_count) || 0,
      logout_count: Number(row.logout_count) || 0,
      play_count: Number(row.play_count) || 0,
      download_count: Number(row.download_count) || 0,
      view_count: Number(row.view_count) || 0,
      report_view_count: Number(row.report_view_count) || 0,
      report_download_count: Number(row.report_download_count) || 0,
      last_action_at: row.last_action_at || null,
      total_session_ms: Number(row.total_session_ms) || 0
    }));
  } catch (error) {
    console.error('Error generating user usage report:', error);
    return [];
  }
}

export async function exportUserUsageReport(startDate = null, endDate = null, maxRows = USER_USAGE_EXPORT_MAX_ROWS) {
  const rows = await getUserUsageReport(startDate, endDate);
  if (rows.length > maxRows) {
    return { rows: [], total: rows.length, truncated: true, maxRows };
  }
  return { rows, total: rows.length, truncated: false, maxRows };
}

export async function getLastLogin(userId) {
  try {
    const { rows } = await pool.query(`
      SELECT login_time FROM user_sessions
      WHERE user_id = $1
      ORDER BY login_time DESC
      LIMIT 1
    `, [userId]);
    return rows.length ? rows[0].login_time : null;
  } catch (error) {
    console.error('Error getting last login:', error);
    return null;
  }
}

export async function getDistinctUsers(search = null, limit = 20) {
  try {
    const term = search && search.trim() !== '' ? search.trim() : null;
    if (term) {
      const { rows } = await pool.query(`
        SELECT user_id, user_email FROM (
          SELECT user_id, user_email FROM audit_logs
          UNION ALL
          SELECT user_id, user_email FROM user_sessions
        ) sub
        WHERE user_email LIKE '%' || $1 || '%' OR user_id LIKE '%' || $1 || '%'
        GROUP BY user_id, user_email
        ORDER BY user_email
        LIMIT $2
      `, [term, limit]);
      return rows;
    } else {
      const { rows } = await pool.query(`
        SELECT user_id, user_email FROM (
          SELECT user_id, user_email FROM audit_logs
          UNION ALL
          SELECT user_id, user_email FROM user_sessions
        ) sub
        GROUP BY user_id, user_email
        ORDER BY user_email
        LIMIT $1
      `, [limit]);
      return rows;
    }
  } catch (error) {
    console.error('Error getting distinct users:', error);
    return [];
  }
}

// ============================================================
// Reporting
// ============================================================
export async function upsertReportRow(row) {
  try {
    const normalizedRow = { ...row };
    const normalizedTs = normalizeReportTimestamp(normalizedRow.timestamp);
    if (normalizedTs) normalizedRow.timestamp = normalizedTs;
    await pool.query(`
      INSERT INTO reporting (
        call_id, timestamp, campaign, call_type, agent, agent_name, disposition,
        ani, customer_name, dnis, call_time, bill_time_rounded, cost, ivr_time,
        queue_wait_time, ring_time, talk_time, hold_time, park_time,
        after_call_work_time, transfers, conferences, holds, abandoned, recordings, raw_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
      )
      ON CONFLICT(call_id) DO UPDATE SET
        timestamp=EXCLUDED.timestamp, campaign=EXCLUDED.campaign, call_type=EXCLUDED.call_type,
        agent=EXCLUDED.agent, agent_name=EXCLUDED.agent_name, disposition=EXCLUDED.disposition,
        ani=EXCLUDED.ani, customer_name=EXCLUDED.customer_name, dnis=EXCLUDED.dnis,
        call_time=EXCLUDED.call_time, bill_time_rounded=EXCLUDED.bill_time_rounded, cost=EXCLUDED.cost,
        ivr_time=EXCLUDED.ivr_time, queue_wait_time=EXCLUDED.queue_wait_time, ring_time=EXCLUDED.ring_time,
        talk_time=EXCLUDED.talk_time, hold_time=EXCLUDED.hold_time, park_time=EXCLUDED.park_time,
        after_call_work_time=EXCLUDED.after_call_work_time, transfers=EXCLUDED.transfers,
        conferences=EXCLUDED.conferences, holds=EXCLUDED.holds, abandoned=EXCLUDED.abandoned,
        recordings=EXCLUDED.recordings, raw_json=EXCLUDED.raw_json
    `, [
      normalizedRow.call_id, normalizedRow.timestamp, normalizedRow.campaign, normalizedRow.call_type,
      normalizedRow.agent, normalizedRow.agent_name, normalizedRow.disposition, normalizedRow.ani,
      normalizedRow.customer_name, normalizedRow.dnis, normalizedRow.call_time, normalizedRow.bill_time_rounded,
      normalizedRow.cost, normalizedRow.ivr_time, normalizedRow.queue_wait_time, normalizedRow.ring_time,
      normalizedRow.talk_time, normalizedRow.hold_time, normalizedRow.park_time,
      normalizedRow.after_call_work_time, normalizedRow.transfers, normalizedRow.conferences,
      normalizedRow.holds, normalizedRow.abandoned, normalizedRow.recordings, normalizedRow.raw_json
    ]);
    return true;
  } catch (e) {
    console.error('Failed to upsert report row', e.message, row?.call_id);
    return false;
  }
}

export async function bulkUpsertReports(rows = []) {
  const client = await pool.connect();
  let failed;
  try {
    await client.query('BEGIN');
    let inserted = 0;
    for (const r of rows) {
      const normalizedRow = { ...r };
      const normalizedTs = normalizeReportTimestamp(normalizedRow.timestamp);
      if (normalizedTs) normalizedRow.timestamp = normalizedTs;
      try {
        await client.query(`
          INSERT INTO reporting (
            call_id, timestamp, campaign, call_type, agent, agent_name, disposition,
            ani, customer_name, dnis, call_time, bill_time_rounded, cost, ivr_time,
            queue_wait_time, ring_time, talk_time, hold_time, park_time,
            after_call_work_time, transfers, conferences, holds, abandoned, recordings, raw_json
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
          )
          ON CONFLICT(call_id) DO UPDATE SET
            timestamp=EXCLUDED.timestamp, campaign=EXCLUDED.campaign, call_type=EXCLUDED.call_type,
            agent=EXCLUDED.agent, agent_name=EXCLUDED.agent_name, disposition=EXCLUDED.disposition,
            ani=EXCLUDED.ani, customer_name=EXCLUDED.customer_name, dnis=EXCLUDED.dnis,
            call_time=EXCLUDED.call_time, bill_time_rounded=EXCLUDED.bill_time_rounded, cost=EXCLUDED.cost,
            ivr_time=EXCLUDED.ivr_time, queue_wait_time=EXCLUDED.queue_wait_time, ring_time=EXCLUDED.ring_time,
            talk_time=EXCLUDED.talk_time, hold_time=EXCLUDED.hold_time, park_time=EXCLUDED.park_time,
            after_call_work_time=EXCLUDED.after_call_work_time, transfers=EXCLUDED.transfers,
            conferences=EXCLUDED.conferences, holds=EXCLUDED.holds, abandoned=EXCLUDED.abandoned,
            recordings=EXCLUDED.recordings, raw_json=EXCLUDED.raw_json
        `, [
          normalizedRow.call_id, normalizedRow.timestamp, normalizedRow.campaign, normalizedRow.call_type,
          normalizedRow.agent, normalizedRow.agent_name, normalizedRow.disposition, normalizedRow.ani,
          normalizedRow.customer_name, normalizedRow.dnis, normalizedRow.call_time, normalizedRow.bill_time_rounded,
          normalizedRow.cost, normalizedRow.ivr_time, normalizedRow.queue_wait_time, normalizedRow.ring_time,
          normalizedRow.talk_time, normalizedRow.hold_time, normalizedRow.park_time,
          normalizedRow.after_call_work_time, normalizedRow.transfers, normalizedRow.conferences,
          normalizedRow.holds, normalizedRow.abandoned, normalizedRow.recordings, normalizedRow.raw_json
        ]);
        inserted++;
      } catch { /* ignore duplicate errors */ }
    }
    await client.query('COMMIT');
    return inserted;
  } catch (e) {
    failed = e;
    try { await client.query('ROLLBACK'); } catch (err) { /* connection may be gone */ }
    console.error('Failed to bulk upsert reports:', e.message);
    return 0;
  } finally {
    try { client.release(failed); } catch (err) { /* already released */ }
  }
}

function buildReportWhereClause(params, { start, end, agent, agentName, campaign, callType, disposition, phone, callId, customerName, afterCallWork, callTimeMin, callTimeMax, transfers, conferences, abandoned }, { alias = '' } = {}) {
  const conditions = [];
  let paramIdx = params.length + 1;
  const p = alias ? `${alias}.` : '';

  if (start) { conditions.push(`${p}timestamp >= $${paramIdx++}`); params.push(start); }
  if (end) { conditions.push(`${p}timestamp <= $${paramIdx++}`); params.push(end); }
  if (agent) { conditions.push(`${p}agent LIKE '%' || $${paramIdx++} || '%'`); params.push(agent); }
  if (agentName) { conditions.push(`${p}agent_name LIKE '%' || $${paramIdx++} || '%'`); params.push(agentName); }
  if (campaign) { conditions.push(`${p}campaign = $${paramIdx++}`); params.push(campaign); }
  if (callType) { conditions.push(`${p}call_type = $${paramIdx++}`); params.push(callType); }
  if (disposition) { conditions.push(`${p}disposition = $${paramIdx++}`); params.push(disposition); }
  if (phone) {
    // A full number matches on normalized digits (indexed equality, and it
    // ignores +1 / dashes / parens). Anything shorter keeps the original
    // substring behaviour, which the trigram indexes now serve.
    const digits = phoneDigits(phone);
    if (digits.length >= PHONE_EXACT_MIN_DIGITS) {
      conditions.push(`(${phoneLast10Expr(`${p}ani`)} = $${paramIdx} OR ${phoneLast10Expr(`${p}dnis`)} = $${paramIdx})`);
      params.push(digits.slice(-10));
    } else {
      conditions.push(`(${p}ani LIKE '%' || $${paramIdx} || '%' OR ${p}dnis LIKE '%' || $${paramIdx} || '%')`);
      params.push(phone);
    }
    paramIdx++;
  }
  if (callId) { conditions.push(`${p}call_id LIKE '%' || $${paramIdx++} || '%'`); params.push(callId); }
  if (customerName) { conditions.push(`${p}customer_name LIKE '%' || $${paramIdx++} || '%'`); params.push(customerName); }
  if (afterCallWork !== null && afterCallWork !== undefined) { conditions.push(`${p}after_call_work_time >= $${paramIdx++}`); params.push(afterCallWork); }
  if (callTimeMin !== null && callTimeMin !== undefined) { conditions.push(`${p}call_time >= $${paramIdx++}`); params.push(callTimeMin); }
  if (callTimeMax !== null && callTimeMax !== undefined) { conditions.push(`${p}call_time <= $${paramIdx++}`); params.push(callTimeMax); }
  if (transfers !== null && transfers !== undefined) { conditions.push(`${p}transfers = $${paramIdx++}`); params.push(transfers); }
  if (conferences !== null && conferences !== undefined) { conditions.push(`${p}conferences = $${paramIdx++}`); params.push(conferences); }
  if (abandoned !== null && abandoned !== undefined) { conditions.push(`${p}abandoned = $${paramIdx++}`); params.push(abandoned); }

  return conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
}

// Call-time sorts put calls with no recorded call time last in both directions,
// and break ties newest-first so pages stay stable.
// There is deliberately no index on call_time: with one, the planner walks it for
// date-ranged sorts and, because call_id order tracks time, can read every
// zero-length call ever made before reaching the range (30 days, shortest first:
// 0.26s -> 1.5s on 3M rows). Without it a date-ranged sort is a top-N sort over
// that range; only an all-dates sort scans the whole table.
function buildReportOrderBy(sortBy, sortDir, { alias = '' } = {}) {
  const p = alias ? `${alias}.` : '';
  if (sortBy === 'callTime') return `ORDER BY ${p}call_time ${sortDir} NULLS LAST, ${p}timestamp DESC, ${p}call_id DESC`;
  return `ORDER BY ${p}timestamp ${sortDir}`;
}

export async function queryReports({ start = null, end = null, agent = null, agentName = null, campaign = null, callType = null, disposition = null, phone = null, callId = null, customerName = null, afterCallWork = null, callTimeMin = null, callTimeMax = null, transfers = null, conferences = null, abandoned = null, hasRecording = null, limit = 100, offset = 0, sort = 'desc', sortBy = 'timestamp' } = {}) {
  try {
    const norm = v => (v && typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
    const normLike = (v) => { if (v === null || v === undefined) return null; const str = String(v).trim(); return str === '' ? null : str; };
    const normDuration = (v) => { if (v === null || v === undefined) return null; const num = Number(v); if (!Number.isFinite(num) || num < 0) return null; return Math.floor(num); };
    const normBinary = (v) => { if (v === null || v === undefined) return null; const num = Number(v); if (!Number.isFinite(num)) return null; if (num === 0 || num === 1) return num; return null; };

    const s = norm(start), e = norm(end), a = norm(agent), aName = norm(agentName);
    const c = norm(campaign), ct = norm(callType), disp = norm(disposition);
    const phoneNorm = normLike(phone), ci = normLike(callId), cust = normLike(customerName);
    const acw = normDuration(afterCallWork), tr = normBinary(transfers), conf = normBinary(conferences), ab = normBinary(abandoned);
    const ctMin = normDuration(callTimeMin), ctMax = normDuration(callTimeMax);
    const hr = normBinary(hasRecording);
    const sortDir = sort === 'asc' ? 'ASC' : 'DESC';

    console.log(`[QUERY REPORTS] Filters: start=${s}, end=${e}, agent=${a}, agentName=${aName}, campaign=${c}, callType=${ct}, phone=${phoneNorm}, callId=${ci}, customer=${cust}, afterCallWorkMin=${acw}, callTimeMin=${ctMin}, callTimeMax=${ctMax}, transfers=${tr}, conferences=${conf}, abandoned=${ab}, limit=${limit}, offset=${offset}, sortBy=${sortBy}, sort=${sortDir}`);

    const filterArgs = {
      start: s, end: e, agent: a, agentName: aName, campaign: c, callType: ct,
      disposition: disp, phone: phoneNorm, callId: ci, customerName: cust,
      afterCallWork: acw, callTimeMin: ctMin, callTimeMax: ctMax, transfers: tr, conferences: conf, abandoned: ab
    };

    // Build WHERE clause with "r." alias for the data query
    const dataParams = [];
    let dataWhereClause = buildReportWhereClause(dataParams, filterArgs, { alias: 'r' });

    // Build a second WHERE clause without alias for the COUNT query
    const countParams = [];
    let countWhereClause = buildReportWhereClause(countParams, filterArgs);

    // hasRecording: a semi-join against files, not a LEFT JOIN. The previous
    // "LEFT JOIN (SELECT DISTINCT call_id FROM files)" could not be inlined by
    // the planner, so the full distinct set was materialized on every request
    // and the ORDER BY ... LIMIT could not stream off the timestamp index.
    const recordingExists = (alias) => `EXISTS (SELECT 1 FROM files WHERE files.call_id = ${alias}.call_id)`;
    const appendCondition = (clause, condition) => (clause ? `${clause} AND ${condition}` : `WHERE ${condition}`);

    if (hr === 1) {
      dataWhereClause = appendCondition(dataWhereClause, recordingExists('r'));
      countWhereClause = appendCondition(countWhereClause, recordingExists('reporting'));
    } else if (hr === 0) {
      dataWhereClause = appendCondition(dataWhereClause, `NOT ${recordingExists('r')}`);
      countWhereClause = appendCondition(countWhereClause, `NOT ${recordingExists('reporting')}`);
    }

    const paramIdx = dataParams.length + 1;
    dataParams.push(limit, offset);

    // Explicit column list — exclude raw_json (large TEXT blob, only needed for hydration
    // which we now do selectively) and recordings (rarely needed in list views).
    const reportCols = `r.call_id, r.timestamp, r.campaign, r.call_type, r.agent, r.agent_name,
      r.disposition, r.ani, r.customer_name, r.dnis, r.call_time, r.bill_time_rounded,
      r.cost, r.ivr_time, r.queue_wait_time, r.ring_time, r.talk_time, r.hold_time,
      r.park_time, r.after_call_work_time, r.transfers, r.conferences, r.holds,
      r.abandoned, r.created_at,
      ${recordingExists('r')} AS "hasRecording"`;

    const dataQuery = `SELECT ${reportCols}
      FROM reporting r
      ${dataWhereClause}
      ${buildReportOrderBy(sortBy, sortDir, { alias: 'r' })} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

    // The count is the expensive half of this request: LIMIT bounds the data
    // query, but nothing bounds a COUNT(*). Two mitigations:
    //   1. Only count on the first page. ReportsPage resets to page 1 whenever
    //      a filter changes, so while paging the client's cached total is still
    //      correct for the current filter set.
    //   2. Stop counting at the cap, so a broad filter can never walk millions
    //      of rows. Counting to CAP + 1 tells "exactly CAP" from "more".
    const shouldCount = offset === 0;
    const countQuery = `SELECT COUNT(*) as total FROM (
        SELECT 1 FROM reporting ${countWhereClause} LIMIT ${REPORT_COUNT_CAP + 1}
      ) t`;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      shouldCount ? pool.query(countQuery, countParams) : Promise.resolve(null)
    ]);

    // null total means "unchanged since page 1" — the caller keeps its value.
    let total = null;
    let totalCapped = false;
    if (countResult) {
      const counted = parseInt(countResult.rows[0].total, 10);
      totalCapped = counted > REPORT_COUNT_CAP;
      total = totalCapped ? REPORT_COUNT_CAP : counted;
    }

    console.log(`[QUERY REPORTS] Results: returned ${dataResult.rows.length} rows, total=${total === null ? 'skipped' : total}${totalCapped ? '+ (capped)' : ''}`);
    return { rows: dataResult.rows, total, totalCapped, sort: sort === 'asc' ? 'asc' : 'desc' };
  } catch (e) {
    console.error('Failed to query reports', e);
    return { rows: [], total: 0, totalCapped: false };
  }
}

export async function exportReports({ start = null, end = null, agent = null, agentName = null, campaign = null, callType = null, disposition = null, phone = null, callId = null, customerName = null, afterCallWork = null, callTimeMin = null, callTimeMax = null, transfers = null, conferences = null, abandoned = null, hasRecording = null, sort = 'desc', sortBy = 'timestamp' } = {}, maxRows = REPORT_EXPORT_MAX_ROWS) {
  try {
    const norm = v => (v && typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
    const normLike = (v) => { if (v === null || v === undefined) return null; const str = String(v).trim(); return str === '' ? null : str; };
    const normDuration = (v) => { if (v === null || v === undefined) return null; const num = Number(v); if (!Number.isFinite(num) || num < 0) return null; return Math.floor(num); };
    const normBinary = (v) => { if (v === null || v === undefined) return null; const num = Number(v); if (!Number.isFinite(num)) return null; if (num === 0 || num === 1) return num; return null; };

    const s = norm(start), e = norm(end), a = norm(agent), aName = norm(agentName);
    const c = norm(campaign), ct = norm(callType), disp = norm(disposition);
    const phoneNorm = normLike(phone), ci = normLike(callId), cust = normLike(customerName);
    const hr = normBinary(hasRecording);
    const acw = normDuration(afterCallWork), tr = normBinary(transfers), conf = normBinary(conferences), ab = normBinary(abandoned);
    const ctMin = normDuration(callTimeMin), ctMax = normDuration(callTimeMax);
    const sortDir = sort === 'asc' ? 'ASC' : 'DESC';

    const params = [];
    const whereClause = buildReportWhereClause(params, {
      start: s, end: e, agent: a, agentName: aName, campaign: c, callType: ct,
      disposition: disp, phone: phoneNorm, callId: ci, customerName: cust,
      afterCallWork: acw, callTimeMin: ctMin, callTimeMax: ctMax, transfers: tr, conferences: conf, abandoned: ab
    });

    let countHasRecording = '';
    if (hr === 1) {
      countHasRecording = (whereClause ? ' AND ' : ' WHERE ') + 'EXISTS (SELECT 1 FROM files WHERE files.call_id = reporting.call_id)';
    } else if (hr === 0) {
      countHasRecording = (whereClause ? ' AND ' : ' WHERE ') + 'NOT EXISTS (SELECT 1 FROM files WHERE files.call_id = reporting.call_id)';
    }

    // This count only decides whether the export exceeds maxRows, so stop at
    // maxRows + 1. An unbounded COUNT(*) here would scan the whole table just
    // to tell the caller a number we then refuse to act on.
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM (
         SELECT 1 FROM reporting ${whereClause}${countHasRecording} LIMIT ${maxRows + 1}
       ) t`,
      params
    );
    const counted = parseInt(countResult.rows[0].total, 10);

    if (counted > maxRows) {
      // total is not the true row count — only "more than maxRows".
      return { rows: [], total: null, truncated: true, maxRows, sort: sort === 'asc' ? 'asc' : 'desc' };
    }
    const total = counted;

    const dataResult = await pool.query(
      `SELECT * FROM reporting ${whereClause}${countHasRecording} ${buildReportOrderBy(sortBy, sortDir)}`,
      params
    );

    return { rows: dataResult.rows, total, truncated: false, maxRows, sort: sort === 'asc' ? 'asc' : 'desc' };
  } catch (e) {
    console.error('Failed to export reports', e);
    return { rows: [], total: 0, truncated: false, maxRows, sort: sort === 'asc' ? 'asc' : 'desc', error: e.message };
  }
}

export async function getReportingSummary() {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as total, MIN(timestamp) as "minTs", MAX(timestamp) as "maxTs" FROM reporting`);
    return rows[0] || { total: 0, minTs: null, maxTs: null };
  } catch (e) {
    return { total: 0, minTs: null, maxTs: null, error: e.message };
  }
}

// Postgres 16 can't skip ahead in a b-tree for SELECT DISTINCT, so on a
// multi-million-row reporting table it reads every row just to find a handful
// of values. This walks the column's index instead: each step jumps straight to
// the next larger value, so the cost is one index probe per distinct value.
// `> ''` excludes both NULL and empty strings. `column` is interpolated, so it
// must be a constant naming an indexed reporting column.
async function getDistinctReportingValues(column) {
  try {
    const { rows } = await pool.query(`
      WITH RECURSIVE vals AS (
        (SELECT ${column} AS v FROM reporting WHERE ${column} > '' ORDER BY ${column} LIMIT 1)
        UNION ALL
        SELECT (SELECT ${column} FROM reporting WHERE ${column} > vals.v ORDER BY ${column} LIMIT 1)
        FROM vals WHERE vals.v IS NOT NULL
      )
      SELECT v FROM vals WHERE v IS NOT NULL`);
    return rows.map(r => r.v);
  } catch (e) {
    console.error(`Failed to load distinct reporting ${column} values:`, e.message);
    return [];
  }
}

export async function getDistinctCampaigns() {
  return getDistinctReportingValues('campaign');
}

export async function getDistinctCallTypes() {
  return getDistinctReportingValues('call_type');
}

export async function getDistinctDispositions() {
  return getDistinctReportingValues('disposition');
}

export async function getDistinctFileDispositions() {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT call_disposition FROM files WHERE call_disposition IS NOT NULL AND call_disposition <> '' ORDER BY call_disposition`);
    return rows.map(r => r.call_disposition);
  } catch { return []; }
}

export async function rewriteReportTimestamps({ batchSize = 5000, runAll = true, includeIso = false, dryRun = false } = {}) {
  let processed = 0;
  let updated = 0;
  let errors = 0;
  let batches = 0;
  let lastRowId = 0;
  const conversions = [];

  while (true) {
    const query = includeIso
      ? `SELECT ctid, call_id, timestamp FROM reporting WHERE ctid > $1::text::tid AND timestamp IS NOT NULL ORDER BY ctid ASC LIMIT $2`
      : `SELECT ctid, call_id, timestamp FROM reporting WHERE ctid > $1::text::tid AND timestamp IS NOT NULL AND timestamp !~ $3 ORDER BY ctid ASC LIMIT $2`;

    const params = includeIso
      ? [`(0,${lastRowId})`, batchSize]
      : [`(0,${lastRowId})`, batchSize, '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$'];

    // Simpler approach: use OFFSET-based pagination instead of ctid
    const simpleQuery = includeIso
      ? `SELECT call_id, timestamp FROM reporting WHERE timestamp IS NOT NULL ORDER BY call_id LIMIT $1 OFFSET $2`
      : `SELECT call_id, timestamp FROM reporting WHERE timestamp IS NOT NULL AND timestamp !~ $3 ORDER BY call_id LIMIT $1 OFFSET $2`;

    const simpleParams = includeIso
      ? [batchSize, lastRowId]
      : [batchSize, lastRowId, '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$'];

    let rows;
    try {
      const result = await pool.query(simpleQuery, simpleParams);
      rows = result.rows;
    } catch (e) {
      console.error('[REPORT_TIME] Batch query error:', e.message);
      break;
    }

    if (!rows.length) break;
    batches++;
    processed += rows.length;

    const updates = [];
    for (const row of rows) {
      try {
        const normalized = normalizeReportTimestamp(row.timestamp);
        if (!normalized) {
          errors++;
          continue;
        }
        if (normalized !== row.timestamp) {
          updates.push({ callId: row.call_id, from: row.timestamp, to: normalized });
        }
      } catch (e) {
        errors++;
      }
    }

    if (!dryRun && updates.length) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of updates) {
          await client.query(`UPDATE reporting SET timestamp = $1 WHERE call_id = $2`, [item.to, item.callId]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('[REPORT_TIME] Batch update error:', e.message);
      } finally {
        client.release();
      }
    }

    if (updates.length) {
      updated += updates.length;
      const spaceRemaining = 5 - conversions.length;
      if (spaceRemaining > 0) {
        conversions.push(...updates.slice(0, spaceRemaining));
      }
    }

    lastRowId += rows.length;
    if (!runAll || rows.length < batchSize) break;
  }

  const legacy = await getLegacyReportTimestampStats(5);
  return {
    processed,
    updated,
    errors,
    batches,
    dryRun,
    includeIso,
    remainingLegacy: legacy.total,
    remainingSamples: legacy.samples,
    sampleConversions: conversions
  };
}

export async function getLegacyReportTimestampStats(limit = 10) {
  try {
    const totalResult = await pool.query(`
      SELECT COUNT(*) as count FROM reporting
      WHERE timestamp IS NOT NULL AND timestamp !~ $1
    `, ['^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$']);
    const samplesResult = await pool.query(`
      SELECT call_id, timestamp FROM reporting
      WHERE timestamp IS NOT NULL AND timestamp !~ $1
      ORDER BY created_at DESC
      LIMIT $2
    `, ['^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$', limit]);
    return { total: parseInt(totalResult.rows[0]?.count || 0, 10), samples: samplesResult.rows };
  } catch (e) {
    if (REPORT_TIME_DEBUG) console.warn('[REPORT_TIME] Legacy timestamp stats failed:', e.message);
    return { total: 0, samples: [], error: e.message };
  }
}

// ============================================================
// Recording favorites, comments & notifications
// Mutations throw; the routes catch. `user` is { id, email (lowercased), name, role }.
// ============================================================

// Looks up a recording and who owns it — the JS twin of ownedBySql(). Owners are
// a set: on a transfer the filename's agent and the Five9 agent can differ, and
// both count. Returns null when the recording isn't indexed.
export async function getRecordingContext(filePath) {
  const { rows } = await pool.query(`
    SELECT f.file_path, f.phone, f.email, f.call_date, f.call_time, f.call_id, f.duration_ms, r.agent
    FROM files f
    LEFT JOIN reporting r ON r.call_id = f.call_id
    WHERE f.file_path = $1
  `, [filePath]);
  if (!rows.length) return null;
  const { agent, ...file } = rows[0];
  const ownerEmails = [...new Set(
    [file.email, agent]
      .filter(value => typeof value === 'string' && value.includes('@'))
      .map(value => value.toLowerCase())
  )];
  return { file, ownerEmails };
}

// Returns true only when a favorite was actually added, so callers audit and
// notify once even if the request is retried or double-clicked.
export async function addFavorite(filePath, user) {
  const { rows } = await pool.query(`
    INSERT INTO recording_favorites (file_path, user_email, user_id, user_name, user_role)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (file_path, user_email) DO NOTHING
    RETURNING id
  `, [filePath, user.email, user.id, user.name, user.role]);
  return rows.length > 0;
}

export async function removeFavorite(filePath, userEmail) {
  const { rows } = await pool.query(
    `DELETE FROM recording_favorites WHERE file_path = $1 AND user_email = $2 RETURNING id`,
    [filePath, userEmail]
  );
  return rows.length > 0;
}

export async function getFavoriteState(filePath, userEmail) {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS favorite_count, COALESCE(bool_or(user_email = $2), false) AS favorited_by_me
    FROM recording_favorites
    WHERE file_path = $1
  `, [filePath, userEmail]);
  return { favoriteCount: rows[0].favorite_count, favoritedByMe: rows[0].favorited_by_me };
}

export async function getRecordingActivity(filePath) {
  const [favorites, comments] = await Promise.all([
    pool.query(`
      SELECT user_email, user_name, user_role, created_at
      FROM recording_favorites
      WHERE file_path = $1
      ORDER BY created_at, id
    `, [filePath]),
    pool.query(`
      SELECT id, user_email, user_name, user_role, body, position_ms, created_at
      FROM recording_comments
      WHERE file_path = $1
      ORDER BY created_at, id
    `, [filePath])
  ]);
  return { favorites: favorites.rows, comments: comments.rows };
}

export async function addComment(filePath, user, body, positionMs) {
  const { rows } = await pool.query(`
    INSERT INTO recording_comments (file_path, user_email, user_id, user_name, user_role, body, position_ms)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, user_email, user_name, user_role, body, position_ms, created_at
  `, [filePath, user.email, user.id, user.name, user.role, body, positionMs]);
  return rows[0];
}

// One statement, so the permission check can't race the delete. Pass
// authorEmail = null to delete regardless of author (managers/admins).
export async function deleteComment(commentId, authorEmail) {
  const { rows } = await pool.query(`
    DELETE FROM recording_comments
    WHERE id = $1 AND ($2::text IS NULL OR user_email = $2)
    RETURNING id, file_path, user_email, user_role, body, position_ms, created_at
  `, [commentId, authorEmail]);
  return rows[0] || null;
}

export async function commentExists(commentId) {
  const { rows } = await pool.query(`SELECT 1 FROM recording_comments WHERE id = $1`, [commentId]);
  return rows.length > 0;
}

export async function getCommenterEmails(filePath) {
  const { rows } = await pool.query(`SELECT DISTINCT user_email FROM recording_comments WHERE file_path = $1`, [filePath]);
  return rows.map(r => r.user_email);
}

// recipientEmails must be lowercased and already exclude the actor.
export async function createNotifications(recipientEmails, type, filePath, actor, commentId = null) {
  if (!recipientEmails.length) return;
  await pool.query(`
    INSERT INTO notifications (recipient_email, type, file_path, actor_email, actor_name, comment_id)
    SELECT recipient, $2::text, $3::text, $4::text, $5::text, $6::int
    FROM unnest($1::text[]) AS recipient
  `, [recipientEmails, type, filePath, actor.email, actor.name, commentId]);
}

// Un-favoriting retracts the owner's notification if they haven't seen it yet.
export async function deleteUnreadFavoriteNotifications(filePath, actorEmail) {
  await pool.query(`
    DELETE FROM notifications
    WHERE file_path = $1 AND type = 'favorite' AND actor_email = $2 AND read_at IS NULL
  `, [filePath, actorEmail]);
}

export async function deleteCommentNotifications(filePath, commentId) {
  await pool.query(`DELETE FROM notifications WHERE file_path = $1 AND comment_id = $2`, [filePath, commentId]);
}

async function countUnreadNotifications(recipientEmail) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS unread FROM notifications WHERE recipient_email = $1 AND read_at IS NULL`,
    [recipientEmail]
  );
  return rows[0].unread;
}

export async function getNotifications(recipientEmail, limit) {
  const [list, unreadCount] = await Promise.all([
    pool.query(`
      SELECT n.id, n.type, n.file_path, n.actor_email, n.actor_name, n.created_at, n.read_at,
             f.call_date, f.call_time, f.phone, left(c.body, 200) AS comment_excerpt
      FROM notifications n
      LEFT JOIN files f ON f.file_path = n.file_path
      LEFT JOIN recording_comments c ON c.id = n.comment_id
      WHERE n.recipient_email = $1
      ORDER BY n.id DESC
      LIMIT $2
    `, [recipientEmail, limit]),
    countUnreadNotifications(recipientEmail)
  ]);
  return { notifications: list.rows, unreadCount };
}

// ids = null marks all of the recipient's notifications read.
export async function markNotificationsRead(recipientEmail, ids) {
  await pool.query(`
    UPDATE notifications SET read_at = NOW()
    WHERE recipient_email = $1 AND read_at IS NULL AND ($2::int[] IS NULL OR id = ANY($2::int[]))
  `, [recipientEmail, ids]);
  return countUnreadNotifications(recipientEmail);
}

// ============================================================
// Transcriptions
// ============================================================
// call_date is stored as YYYY-MM-DD text, so string comparison is date order.
// skipDispositions: lowercased dispositions that are never transcribed. The disposition is the
// one the app shows (Five9 reporting first, else the file's own), compared case-insensitively.
export async function getFilesNeedingTranscription(cutoffDate, minDurationMs, limit, skipDispositions = []) {
  const { rows } = await pool.query(`
    SELECT f.file_path
    FROM files f
    LEFT JOIN transcriptions t ON t.file_path = f.file_path
    WHERE t.file_path IS NULL AND f.call_date >= $1 AND f.duration_ms > $2
      AND lower(trim(COALESCE(
        (SELECT r.disposition FROM reporting r WHERE r.call_id = f.call_id AND r.disposition <> '' LIMIT 1),
        f.call_disposition, ''))) <> ALL($4::text[])
    ORDER BY f.call_date DESC, f.call_time DESC
    LIMIT $3
  `, [cutoffDate, minDurationMs, limit, skipDispositions]);
  return rows.map(r => r.file_path);
}

// Points a recording at a different Scriberr job (found by title after its own ID went missing).
export async function adoptScriberrJob(filePath, scriberrId) {
  await pool.query(`UPDATE transcriptions SET scriberr_id = $2, status = 'processing', error = NULL, updated_at = NOW() WHERE file_path = $1`, [filePath, scriberrId]);
}

// Forgets a recording's transcription so the worker submits it again.
export async function resetTranscription(filePath) {
  await pool.query('DELETE FROM transcriptions WHERE file_path = $1', [filePath]);
}

// Scriberr jobs still running, plus ones whose redaction failed and should be retried.
export async function getPendingTranscriptions() {
  const { rows } = await pool.query(`
    SELECT file_path, scriberr_id, attempts FROM transcriptions
    WHERE status IN ('processing', 'redaction_failed') AND scriberr_id IS NOT NULL
    ORDER BY updated_at
  `);
  return rows;
}

export async function upsertTranscription(filePath, { scriberrId = null, status, transcriptText = null, utterances = null, summary = null, error = null }) {
  await pool.query(`
    INSERT INTO transcriptions (file_path, scriberr_id, status, transcript_text, utterances, summary, error)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (file_path) DO UPDATE SET
      scriberr_id = COALESCE(EXCLUDED.scriberr_id, transcriptions.scriberr_id),
      status = EXCLUDED.status,
      transcript_text = EXCLUDED.transcript_text,
      utterances = EXCLUDED.utterances,
      summary = EXCLUDED.summary,
      error = EXCLUDED.error,
      updated_at = NOW()
  `, [filePath, scriberrId, status, transcriptText, utterances ? JSON.stringify(utterances) : null, summary, error]);
}

// Records a failed redaction without storing any transcript text; returns the attempt count.
export async function markRedactionFailed(filePath, error, maxAttempts) {
  const { rows } = await pool.query(`
    UPDATE transcriptions
    SET attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= $3 THEN 'error' ELSE 'redaction_failed' END,
        error = $2, transcript_text = NULL, utterances = NULL, updated_at = NOW()
    WHERE file_path = $1
    RETURNING attempts
  `, [filePath, error, maxAttempts]);
  return rows[0]?.attempts ?? 0;
}

// Completed transcripts (Scriberr or older AssemblyAI ones) that have not been scored yet,
// plus failed Claude attempts waiting to be retried (10 minutes after the last try).
export async function getTranscriptionsNeedingAnalysis(limit) {
  const { rows } = await pool.query(`
    SELECT t.file_path, t.scriberr_id, t.utterances FROM transcriptions t
    LEFT JOIN call_analyses ca ON ca.file_path = t.file_path
    WHERE t.status = 'completed'
      AND (ca.file_path IS NULL OR (ca.status = 'retry' AND ca.updated_at < NOW() - INTERVAL '10 minutes'))
      AND t.utterances IS NOT NULL AND jsonb_array_length(t.utterances) > 0
    ORDER BY t.updated_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

export async function saveCallAnalysis(filePath, result, model) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = result.scores;
    await client.query(`
      INSERT INTO call_analyses (file_path, status, model, error, overall_score, intro_score, retention_score, info_score,
        sentiment_score, objection_score, control_score, analysis, stats, speaker_checked_at)
      VALUES ($1, 'completed', $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (file_path) DO UPDATE SET
        status = 'completed', model = EXCLUDED.model, error = NULL, overall_score = EXCLUDED.overall_score,
        intro_score = EXCLUDED.intro_score, retention_score = EXCLUDED.retention_score, info_score = EXCLUDED.info_score,
        sentiment_score = EXCLUDED.sentiment_score, objection_score = EXCLUDED.objection_score,
        control_score = EXCLUDED.control_score, analysis = EXCLUDED.analysis, stats = EXCLUDED.stats,
        speaker_checked_at = NOW(), updated_at = NOW()
    `, [filePath, model, result.overall, s.intro, s.retention, s.info, s.sentiment, s.objection, s.control,
      JSON.stringify(result.analysis), JSON.stringify(result.stats)]);
    await client.query('DELETE FROM call_topics WHERE file_path = $1', [filePath]);
    for (const [kind, values] of [['topic', result.topics], ['keyword', result.keywords]]) {
      for (const value of values) {
        await client.query('INSERT INTO call_topics (file_path, kind, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [filePath, kind, value]);
      }
    }
    // Older AssemblyAI rows keep their summary; new Scriberr rows get it from the analysis.
    if (result.summary) {
      await client.query('UPDATE transcriptions SET summary = COALESCE(summary, $2), updated_at = NOW() WHERE file_path = $1', [filePath, result.summary]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Records a failed attempt that will be retried; after maxAttempts it becomes a permanent error.
export async function saveCallAnalysisRetry(filePath, error, model, maxAttempts) {
  const { rows } = await pool.query(`
    INSERT INTO call_analyses (file_path, status, model, error, attempts)
    VALUES ($1, CASE WHEN 1 >= $4 THEN 'error' ELSE 'retry' END, $2, $3, 1)
    ON CONFLICT (file_path) DO UPDATE SET
      attempts = call_analyses.attempts + 1,
      status = CASE WHEN call_analyses.attempts + 1 >= $4 THEN 'error' ELSE 'retry' END,
      model = EXCLUDED.model, error = EXCLUDED.error, updated_at = NOW()
    RETURNING attempts, status
  `, [filePath, model, error, maxAttempts]);
  return rows[0];
}

// Failed analyses are not retried automatically; an admin re-score deletes the row.
export async function saveCallAnalysisError(filePath, error, model) {
  await pool.query(`
    INSERT INTO call_analyses (file_path, status, model, error) VALUES ($1, 'error', $2, $3)
    ON CONFLICT (file_path) DO UPDATE SET status = 'error', model = EXCLUDED.model, error = EXCLUDED.error, updated_at = NOW()
  `, [filePath, model, error]);
}

// Scorecards made before the speaker check existed, newest first.
export async function getAnalysesNeedingSpeakerCheck(limit) {
  const { rows } = await pool.query(`
    SELECT ca.file_path, t.scriberr_id, ca.analysis->>'agentSpeaker' AS agent_speaker, t.utterances
    FROM call_analyses ca JOIN transcriptions t ON t.file_path = ca.file_path
    WHERE ca.status = 'completed' AND ca.speaker_checked_at IS NULL
      AND t.utterances IS NOT NULL AND jsonb_array_length(t.utterances) > 0
    ORDER BY ca.created_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

export async function markSpeakerChecked(filePath) {
  await pool.query('UPDATE call_analyses SET speaker_checked_at = NOW() WHERE file_path = $1', [filePath]);
}

// Deletes scorecards that failed with exactly this error, so the worker scores those calls again.
export async function requeueFailedAnalyses(error) {
  const { rowCount } = await pool.query(`DELETE FROM call_analyses WHERE status = 'error' AND error = $1`, [error]);
  return rowCount;
}

export async function deleteCallAnalysis(filePath) {
  const { rowCount } = await pool.query('DELETE FROM call_analyses WHERE file_path = $1', [filePath]);
  await pool.query('DELETE FROM call_topics WHERE file_path = $1', [filePath]);
  return rowCount > 0;
}

export async function getTranscription(filePath) {
  const { rows } = await pool.query(`SELECT status, summary, utterances, error FROM transcriptions WHERE file_path = $1`, [filePath]);
  return rows[0] || null;
}

export async function getCallAnalysis(filePath) {
  const { rows } = await pool.query(`
    SELECT status, error, overall_score::float AS overall_score, intro_score, retention_score, info_score, sentiment_score,
      objection_score, control_score, analysis, stats, updated_at
    FROM call_analyses WHERE file_path = $1
  `, [filePath]);
  if (!rows.length) return null;
  const { rows: topicRows } = await pool.query('SELECT kind, value FROM call_topics WHERE file_path = $1 ORDER BY kind, value', [filePath]);
  return {
    ...rows[0],
    topics: topicRows.filter(r => r.kind === 'topic').map(r => r.value),
    keywords: topicRows.filter(r => r.kind === 'keyword').map(r => r.value)
  };
}

// ============================================================
// Agents, dashboard, search, trends, coaching
// ============================================================
// A call's agent, stored on the recording by the scan (see fillFileAgents).
const AGENT_SQL = `f.agent_email`;
const CALLS_FROM = `files f LEFT JOIN reporting r ON r.call_id = f.call_id
  LEFT JOIN call_analyses ca ON ca.file_path = f.file_path AND ca.status = 'completed'`;

// Columns for a call row in lists (recent, best, worst, search, coaching).
const callRowSql = (scoreExpr = 'ca.overall_score') => `f.file_path, f.call_date, f.call_time, f.phone, f.call_id, f.duration_ms,
  COALESCE(r.disposition, f.call_disposition) AS disposition, COALESCE(f.customer_name, r.customer_name) AS customer_name,
  ${AGENT_SQL} AS agent_email, COALESCE(f.agent_name, r.agent_name) AS agent_name, ${scoreExpr}::float AS overall_score`;
const CALL_ROW_SQL = callRowSql();

export async function getRecordingReport(callId) {
  if (!callId) return null;
  const { rows } = await pool.query(`
    SELECT timestamp, campaign, call_type, agent, agent_name, disposition, ani, customer_name, dnis, call_time,
      ivr_time, queue_wait_time, ring_time, talk_time, hold_time, park_time, after_call_work_time, transfers, conferences, holds, abandoned
    FROM reporting WHERE call_id = $1
  `, [callId]);
  return rows[0] || null;
}

const SCORE_COLUMNS = ['intro', 'retention', 'info', 'sentiment', 'objection', 'control'];

// Aggregates for a set of agents ($1, a text[]) for the current period ($2..$3)
// and the previous one ($4..$5), in one pass.
// Runs a dashboard query and logs it when it takes over a second, with the agent count
// and date range, so a slow Home page names the query responsible.
const SLOW_QUERY_MS = 1000;
async function timedQuery(label, text, params) {
  const started = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - started;
  if (ms >= SLOW_QUERY_MS) {
    const emails = Array.isArray(params[0]) ? `${params[0].length} agents, ` : '';
    console.warn(`🐌 [DB] ${label} ${ms}ms (${emails}${params[1]}..${params[2]})`);
  }
  return result;
}

async function periodKpis(emails, start, end, prevStart, prevEnd) {
  const columns = (alias, from, to) => {
    const f = `FILTER (WHERE f.call_date >= ${from} AND f.call_date <= ${to})`;
    return [
      `COUNT(*) ${f}::int AS ${alias}_calls`,
      `COUNT(ca.overall_score) ${f}::int AS ${alias}_scored`,
      `AVG(ca.overall_score) ${f}::float AS ${alias}_avg_score`,
      `AVG(NULLIF(COALESCE(r.talk_time, 0) + COALESCE(r.hold_time, 0) + COALESCE(r.after_call_work_time, 0), 0)) ${f}::float AS ${alias}_avg_handle_ms`,
      `AVG((ca.stats->>'agentTalkShare')::float) ${f} AS ${alias}_avg_talk_share`,
      ...SCORE_COLUMNS.map(c => `AVG(ca.${c}_score) ${f}::float AS ${alias}_${c}`)
    ].join(',\n      ');
  };
  const { rows: [row] } = await timedQuery('dashboard kpis', `
    SELECT ${columns('cur', '$2', '$3')},
      ${columns('prev', '$4', '$5')}
    FROM ${CALLS_FROM}
    WHERE ${AGENT_SQL} = ANY($1::text[]) AND f.call_date >= $4 AND f.call_date <= $3
  `, [emails, start, end, prevStart, prevEnd]);
  const pick = prefix => Object.fromEntries(Object.entries(row)
    .filter(([k]) => k.startsWith(`${prefix}_`))
    .map(([k, v]) => [k.slice(prefix.length + 1), v]));
  return { current: pick('cur'), previous: pick('prev') };
}

// Lowest or highest scored calls for a set of agents. Their scored calls are
// collected first (MATERIALIZED); otherwise Postgres may walk every scored call
// in the company in score order and probe each one, which takes seconds.
const scoredCallsSql = (direction) => `
  WITH f AS MATERIALIZED (
    SELECT fi.*, ca.overall_score AS score
    FROM files fi JOIN call_analyses ca ON ca.file_path = fi.file_path AND ca.status = 'completed'
    WHERE fi.agent_email = ANY($1::text[]) AND fi.call_date >= $2 AND fi.call_date <= $3 AND ca.overall_score IS NOT NULL
  )
  SELECT ${callRowSql('f.score')}
  FROM f LEFT JOIN reporting r ON r.call_id = f.call_id
  ORDER BY f.score ${direction}, f.call_date DESC LIMIT 5`;

// Home page data for one agent ([email]) or a team (several emails).
export async function getAgentDashboard(emails, { start, end, prevStart, prevEnd, bucket }) {
  const { current, previous } = await periodKpis(emails, start, end, prevStart, prevEnd);
  const trunc = { day: 'day', week: 'week', month: 'month' }[bucket] || 'day';
  // Hourly buckets (Today) come from call_time, stored as HH:MM:SS.
  const bucketSql = bucket === 'hour'
    ? `to_char(f.call_date::date, 'YYYY-MM-DD') || ' ' || CASE WHEN f.call_time ~ '^[0-9]{2}:' THEN left(f.call_time, 2) ELSE '00' END || ':00'`
    : `to_char(date_trunc('${trunc}', f.call_date::date), 'YYYY-MM-DD')`;
  const [trend, dispositions, recent, worst, best] = await Promise.all([
    timedQuery('dashboard trend', `
      SELECT ${bucketSql} AS bucket,
        AVG(ca.overall_score)::float AS avg_score, COUNT(*)::int AS calls
      FROM ${CALLS_FROM}
      WHERE ${AGENT_SQL} = ANY($1::text[]) AND f.call_date >= $2 AND f.call_date <= $3
      GROUP BY 1 ORDER BY 1
    `, [emails, start, end]),
    timedQuery('dashboard outcomes', `
      SELECT COALESCE(r.disposition, f.call_disposition, 'Unknown') AS disposition, COUNT(*)::int AS calls
      FROM ${CALLS_FROM}
      WHERE ${AGENT_SQL} = ANY($1::text[]) AND f.call_date >= $2 AND f.call_date <= $3
      GROUP BY 1 ORDER BY calls DESC LIMIT 6
    `, [emails, start, end]),
    timedQuery('dashboard recent', `
      SELECT ${CALL_ROW_SQL} FROM ${CALLS_FROM}
      WHERE ${AGENT_SQL} = ANY($1::text[]) AND f.call_date >= $2 AND f.call_date <= $3
      ORDER BY f.call_date DESC, f.call_time DESC LIMIT 8
    `, [emails, start, end]),
    timedQuery('dashboard worst', scoredCallsSql('ASC'), [emails, start, end]),
    timedQuery('dashboard best', scoredCallsSql('DESC'), [emails, start, end])
  ]);
  return {
    current,
    previous,
    trend: trend.rows,
    dispositions: dispositions.rows,
    recent: recent.rows,
    worst: worst.rows,
    best: best.rows
  };
}

// Every scored call for an agent ([email]), oldest first, for badge and streak rules.
export async function getAgentScoreHistory(emails) {
  const { rows } = await pool.query(`
    SELECT f.call_date, f.call_time, ca.overall_score::float AS overall, ${SCORE_COLUMNS.map(c => `ca.${c}_score AS ${c}`).join(', ')}
    FROM ${CALLS_FROM}
    WHERE ${AGENT_SQL} = ANY($1::text[]) AND ca.overall_score IS NOT NULL
    ORDER BY f.call_date, f.call_time
  `, [emails]);
  return rows;
}

// One row per team member for the team dashboard: calls, scores and handle
// time this period, plus the previous period's average score. Members with no
// calls still get a row.
export async function getTeamLeaderboard(emails, { start, end, prevStart, prevEnd }) {
  const cur = 'FILTER (WHERE f.call_date >= $2 AND f.call_date <= $3)';
  const { rows } = await timedQuery('team leaderboard', `
    WITH s AS (
      SELECT ${AGENT_SQL} AS email,
        MAX(f.agent_name) AS five9_name,
        COUNT(*) ${cur}::int AS calls,
        COUNT(ca.overall_score) ${cur}::int AS scored,
        AVG(ca.overall_score) ${cur}::float AS avg_score,
        AVG(ca.overall_score) FILTER (WHERE f.call_date >= $4 AND f.call_date <= $5)::float AS prev_avg_score,
        AVG(NULLIF(COALESCE(r.talk_time, 0) + COALESCE(r.hold_time, 0) + COALESCE(r.after_call_work_time, 0), 0)) ${cur}::float AS avg_handle_ms,
        ${SCORE_COLUMNS.map(c => `AVG(ca.${c}_score) ${cur}::float AS ${c}`).join(',\n        ')}
      FROM ${CALLS_FROM}
      WHERE ${AGENT_SQL} = ANY($1::text[]) AND f.call_date >= $4 AND f.call_date <= $3
      GROUP BY 1
    )
    SELECT e.email, s.five9_name, COALESCE(s.calls, 0) AS calls, COALESCE(s.scored, 0) AS scored, s.avg_score, s.prev_avg_score,
      s.avg_handle_ms, ${SCORE_COLUMNS.map(c => `s.${c}`).join(', ')}
    FROM unnest($1::text[]) AS e(email)
    LEFT JOIN s ON s.email = e.email
    ORDER BY s.avg_score DESC NULLS LAST, e.email
  `, [emails, start, end, prevStart, prevEnd]);
  return rows;
}

// Average score per agent for two periods, for the "Most improved" badge.
export async function getTeamScoreChange(start, end, prevStart, prevEnd) {
  const { rows } = await pool.query(`
    SELECT ${AGENT_SQL} AS email,
      AVG(ca.overall_score) FILTER (WHERE f.call_date >= $1 AND f.call_date <= $2)::float AS current,
      AVG(ca.overall_score) FILTER (WHERE f.call_date >= $3 AND f.call_date <= $4)::float AS previous
    FROM ${CALLS_FROM}
    WHERE ca.overall_score IS NOT NULL AND f.call_date >= $3 AND f.call_date <= $2
    GROUP BY 1
  `, [start, end, prevStart, prevEnd]);
  return rows;
}

// Full-text search over redacted transcripts. Returns the ms offset of the first
// matching utterance so the call file can open at that moment.
export async function searchTranscripts({ q, agent = null, dateStart = null, dateEnd = null, limit = 50, offset = 0 }) {
  const { rows } = await pool.query(`
    WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
    SELECT ${CALL_ROW_SQL},
      ts_rank(t.search_tsv, query.tsq) AS rank,
      ts_headline('english', t.transcript_text, query.tsq,
        'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=12, MaxFragments=1') AS snippet,
      (SELECT (u->>'start')::int FROM jsonb_array_elements(t.utterances) u
        WHERE to_tsvector('english', u->>'text') @@ query.tsq ORDER BY (u->>'start')::int LIMIT 1) AS match_ms,
      COUNT(*) OVER()::int AS total
    FROM transcriptions t
    JOIN files f ON f.file_path = t.file_path
    LEFT JOIN reporting r ON r.call_id = f.call_id
    LEFT JOIN call_analyses ca ON ca.file_path = f.file_path AND ca.status = 'completed'
    CROSS JOIN query
    WHERE t.status = 'completed' AND t.search_tsv @@ query.tsq
      AND ($2::text IS NULL OR ${AGENT_SQL} = lower($2))
      AND ($3::text IS NULL OR f.call_date >= $3)
      AND ($4::text IS NULL OR f.call_date <= $4)
    ORDER BY rank DESC, f.call_date DESC
    LIMIT $5 OFFSET $6
  `, [q, agent, dateStart, dateEnd, limit, offset]);
  return { results: rows.map(({ total, rank, ...row }) => row), total: rows[0]?.total ?? 0 };
}

// `emails` limits the trends to some agents (one agent, or a team); null is everyone.
export async function getTrends({ emails = null, start, end, prevStart, prevEnd, bucket }) {
  const trunc = { day: 'day', week: 'week', month: 'month' }[bucket] || 'day';
  const agentFilter = `($5::text[] IS NULL OR ${AGENT_SQL} = ANY($5::text[]))`;
  const base = `FROM call_topics ct
    JOIN files f ON f.file_path = ct.file_path
    LEFT JOIN reporting r ON r.call_id = f.call_id
    LEFT JOIN call_analyses ca ON ca.file_path = f.file_path AND ca.status = 'completed'`;
  const counts = kind => pool.query(`
    SELECT ct.value,
      COUNT(*) FILTER (WHERE f.call_date >= $1 AND f.call_date <= $2)::int AS calls,
      COUNT(*) FILTER (WHERE f.call_date >= $3 AND f.call_date <= $4)::int AS prev_calls,
      AVG(ca.overall_score) FILTER (WHERE f.call_date >= $1 AND f.call_date <= $2)::float AS avg_score
    ${base}
    WHERE ct.kind = '${kind}' AND f.call_date >= $3 AND f.call_date <= $2 AND ${agentFilter}
    GROUP BY ct.value
    HAVING COUNT(*) FILTER (WHERE f.call_date >= $1 AND f.call_date <= $2) > 0
    ORDER BY calls DESC
    LIMIT ${kind === 'topic' ? 20 : 15}
  `, [start, end, prevStart, prevEnd, emails]);
  const [topics, keywords, overTime] = await Promise.all([
    counts('topic'),
    counts('keyword'),
    pool.query(`
      SELECT to_char(date_trunc('${trunc}', f.call_date::date), 'YYYY-MM-DD') AS bucket, ct.value, COUNT(*)::int AS calls
      ${base}
      WHERE ct.kind = 'topic' AND f.call_date >= $1 AND f.call_date <= $2 AND ($3::text[] IS NULL OR ${AGENT_SQL} = ANY($3::text[]))
      GROUP BY 1, 2 ORDER BY 1
    `, [start, end, emails])
  ]);
  return { topics: topics.rows, keywords: keywords.rows, overTime: overTime.rows };
}

// `agents` (text[]) limits the queue to some agents, e.g. a manager's team; null is everyone.
export async function listCoachingItems({ status = null, agents = null } = {}) {
  const { rows } = await pool.query(`
    SELECT ci.id, ci.status, ci.note, ci.created_by, ci.created_by_name, ci.created_at, ci.updated_at, ${CALL_ROW_SQL}
    FROM coaching_items ci
    JOIN files f ON f.file_path = ci.file_path
    LEFT JOIN reporting r ON r.call_id = f.call_id
    LEFT JOIN call_analyses ca ON ca.file_path = f.file_path AND ca.status = 'completed'
    WHERE ($1::text IS NULL OR ci.status = $1) AND ($2::text[] IS NULL OR f.agent_email = ANY($2::text[]))
    ORDER BY ci.updated_at DESC
  `, [status, agents]);
  return rows;
}

export async function getCoachingCounts(agents = null) {
  const { rows } = await pool.query(`
    SELECT ci.status, COUNT(*)::int AS count
    FROM coaching_items ci JOIN files f ON f.file_path = ci.file_path
    WHERE ($1::text[] IS NULL OR f.agent_email = ANY($1::text[]))
    GROUP BY ci.status
  `, [agents]);
  return Object.fromEntries(rows.map(r => [r.status, r.count]));
}

export async function getCoachingItemForFile(filePath) {
  const { rows } = await pool.query('SELECT id, status, note FROM coaching_items WHERE file_path = $1', [filePath]);
  return rows[0] || null;
}

// Adds a call to the queue (or reopens it); returns the item, or null if the call doesn't exist.
export async function addCoachingItem(filePath, actor, note) {
  const { rows } = await pool.query(`
    INSERT INTO coaching_items (file_path, agent_email, created_by, created_by_name, note)
    SELECT f.file_path, ${AGENT_SQL}, $2, $3, $4
    FROM files f LEFT JOIN reporting r ON r.call_id = f.call_id
    WHERE f.file_path = $1
    ON CONFLICT (file_path) DO UPDATE SET status = 'to_review', note = COALESCE(EXCLUDED.note, coaching_items.note), updated_at = NOW()
    RETURNING id, status, note, agent_email
  `, [filePath, actor.email, actor.name, note]);
  return rows[0] || null;
}

export async function updateCoachingItem(id, { status, note }) {
  const { rows } = await pool.query(`
    UPDATE coaching_items
    SET status = COALESCE($2, status), note = COALESCE($3, note), updated_at = NOW()
    WHERE id = $1
    RETURNING id, status, note, file_path, agent_email
  `, [id, status ?? null, note ?? null]);
  return rows[0] || null;
}

export async function getSuggestedCoaching(maxScore, sinceDate, limit = 20, agents = null) {
  const { rows } = await pool.query(`
    SELECT ${CALL_ROW_SQL} FROM ${CALLS_FROM}
    WHERE ca.overall_score <= $1 AND f.call_date >= $2
      AND ($4::text[] IS NULL OR ${AGENT_SQL} = ANY($4::text[]))
      AND NOT EXISTS (SELECT 1 FROM coaching_items ci WHERE ci.file_path = f.file_path)
    ORDER BY ca.overall_score ASC, f.call_date DESC
    LIMIT $3
  `, [maxScore, sinceDate, limit, agents]);
  return rows;
}

// ============================================================
// Five9 teams
// ============================================================
// Replaces the stored Five9 users, groups and memberships in one transaction.
export async function saveFive9TeamSnapshot({ users, groups, members }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM five9_group_members');
    await client.query('DELETE FROM five9_groups');
    await client.query('DELETE FROM five9_users');
    await client.query(`
      INSERT INTO five9_users (username, email, full_name, is_supervisor, active)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[], $5::boolean[])
      ON CONFLICT (username) DO NOTHING
    `, [users.map(u => u.username), users.map(u => u.email), users.map(u => u.fullName), users.map(u => u.isSupervisor), users.map(u => u.active)]);
    await client.query(`
      INSERT INTO five9_groups (name, description) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (name) DO NOTHING
    `, [groups.map(g => g.name), groups.map(g => g.description)]);
    await client.query(`
      INSERT INTO five9_group_members (group_name, username) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING
    `, [members.map(m => m.groupName), members.map(m => m.username)]);
    await client.query(`INSERT INTO app_state (key, value) VALUES ('five9_teams_synced_at', NOW()::text)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Groups where this email belongs to a Five9 supervisor.
export async function getSupervisedGroups(email) {
  const { rows } = await pool.query(`
    SELECT DISTINCT m.group_name AS name
    FROM five9_users u JOIN five9_group_members m ON m.username = u.username
    WHERE u.is_supervisor AND (u.email = $1 OR lower(u.username) = $1)
    ORDER BY 1
  `, [email]);
  return rows.map(r => r.name);
}

export async function getAllFive9Groups() {
  const { rows } = await pool.query('SELECT name FROM five9_groups ORDER BY name');
  return rows.map(r => r.name);
}

// Active non-supervisor members of the given groups (null = every group), by email.
export async function getGroupAgents(groupNames = null) {
  const { rows } = await pool.query(`
    SELECT COALESCE(u.email, lower(u.username)) AS email, MAX(u.full_name) AS name,
      array_agg(DISTINCT m.group_name ORDER BY m.group_name) AS groups
    FROM five9_users u JOIN five9_group_members m ON m.username = u.username
    WHERE u.active AND NOT u.is_supervisor
      AND (u.email IS NOT NULL OR u.username LIKE '%@%')
      AND ($1::text[] IS NULL OR m.group_name = ANY($1::text[]))
    GROUP BY 1
    ORDER BY 2 NULLS LAST, 1
  `, [groupNames]);
  return rows;
}

export async function getFive9TeamStatus() {
  const { rows: [row] } = await pool.query(`
    SELECT (SELECT COUNT(*) FROM five9_groups)::int AS groups,
      (SELECT COUNT(*) FROM five9_users WHERE is_supervisor)::int AS supervisors,
      (SELECT COUNT(*) FROM five9_users WHERE NOT is_supervisor)::int AS agents,
      (SELECT value FROM app_state WHERE key = 'five9_teams_synced_at') AS synced_at
  `);
  return row;
}

// ============================================================
// Export pool for direct queries (used by debug endpoints in index.js)
// ============================================================
export { pool };
export default pool;
