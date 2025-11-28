import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
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
export const ISO_TIMESTAMP_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z';

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const AUDIT_EXPORT_MAX_ROWS = parsePositiveInt(process.env.AUDIT_EXPORT_MAX_ROWS, 10000);
const USER_USAGE_EXPORT_MAX_ROWS = parsePositiveInt(process.env.USER_USAGE_EXPORT_MAX_ROWS, 5000);

export function normalizeReportTimestamp(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (!trimmed) return null;

  const formatUtc = (dt) => dt && dt.isValid() ? dt.utc().format(REPORT_TIMESTAMP_FORMAT) : null;

  // Already ISO-style string (contains T) – normalize and force UTC with Z suffix
  if (trimmed.includes('T')) {
    const parsedIso = dayjs(trimmed);
    const normalizedIso = formatUtc(parsedIso);
    if (normalizedIso) {
      if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] ISO parse raw="${trimmed}" -> "${normalizedIso}"`);
      return normalizedIso;
    }
  }

  // Legacy space-separated format "YYYY-MM-DD HH:mm:ss" – assume UTC if no offset provided
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
    const parsedSpaceUtc = dayjs.utc(trimmed.replace(' ', 'T') + 'Z');
    const normalizedSpaceUtc = formatUtc(parsedSpaceUtc);
    if (normalizedSpaceUtc) {
      if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] Space parse (assume UTC) raw="${trimmed}" -> "${normalizedSpaceUtc}"`);
      return normalizedSpaceUtc;
    }

    // Fallback: interpret naive timestamp using Five9 timezone for backwards compatibility
    const parsedSpaceTz = dayjs.tz(trimmed, 'YYYY-MM-DD HH:mm:ss', REPORT_TIMEZONE);
    const normalizedSpaceTz = formatUtc(parsedSpaceTz);
    if (normalizedSpaceTz) {
      if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] Space parse (tz fallback ${REPORT_TIMEZONE}) raw="${trimmed}" -> "${normalizedSpaceTz}"`);
      return normalizedSpaceTz;
    }
  }

  // Five9 CSV export format "Tue, 25 Nov 2025 09:55:01" – interpret using configured timezone
  const parsedFive9 = dayjs.tz(trimmed, 'ddd, DD MMM YYYY HH:mm:ss', REPORT_TIMEZONE);
  const normalizedFive9 = formatUtc(parsedFive9);
  if (normalizedFive9) {
    if (REPORT_TIME_DEBUG) console.log(`[REPORT_TIME] Five9 parse raw="${trimmed}" tz=${REPORT_TIMEZONE} -> "${normalizedFive9}"`);
    return normalizedFive9;
  }

  // Fallback: let dayjs try its best; still coerce to UTC if valid
  const fallback = formatUtc(dayjs(trimmed));
  if (REPORT_TIME_DEBUG && fallback) {
    console.log(`[REPORT_TIME] Fallback parse raw="${trimmed}" -> "${fallback}"`);
  } else if (REPORT_TIME_DEBUG) {
    console.log(`[REPORT_TIME] Failed parse raw="${trimmed}"`);
  }
  return fallback || null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path. Provide cross-platform fallback if /root not available (e.g., Windows dev)
let DB_PATH = process.env.DB_PATH || '/root/db/recbot.db';
try {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    // If attempting to create /root/... fails or path starts with /root on non-Unix, fallback
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      const fallback = path.join(process.cwd(), 'data');
      if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
      DB_PATH = path.join(fallback, 'recbot.db');
      console.warn(`⚠️  Falling back DB path to ${DB_PATH}`);
    }
  }
} catch (e) {
  console.warn('⚠️  DB path initialization issue, using local fallback:', e.message);
  const fallback = path.join(process.cwd(), 'data');
  if (!fs.existsSync(fallback)) {
    try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
  }
  DB_PATH = path.join(fallback, 'recbot.db');
}

// Initialize database
const db = new Database(DB_PATH);

// Register custom function to convert Five9 timestamp to ISO format
// "Thu, 23 Oct 2025 12:47:37" -> "2025-10-23 12:47:37"
db.function('five9_to_iso', (timestamp) => {
  const normalized = normalizeReportTimestamp(timestamp);
  if (!normalized) return null;
  return normalized.replace('T', ' ').replace('Z', '');
});

// Enable WAL mode for better performance with concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = 10000');
db.pragma('temp_store = MEMORY');

// Create files table for metadata indexing
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    phone TEXT,
    email TEXT,
    call_date TEXT,  -- Store as YYYY-MM-DD for easy querying
    call_time TEXT,  -- Store as HH:MM:SS
    call_id TEXT,    -- numeric call identifier extracted from filename
    duration_ms INTEGER,
    file_size INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Reporting table (separate)
db.exec(`
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
    cost REAL,
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create indexes for fast querying
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_files_phone ON files(phone);
  CREATE INDEX IF NOT EXISTS idx_files_email ON files(email);
  CREATE INDEX IF NOT EXISTS idx_files_call_date ON files(call_date);
  CREATE INDEX IF NOT EXISTS idx_files_call_time ON files(call_time);
  CREATE INDEX IF NOT EXISTS idx_files_duration ON files(duration_ms);
  CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
  CREATE INDEX IF NOT EXISTS idx_files_composite ON files(call_date, phone, email);
`);

// Migration: ensure call_id column exists on files and index created AFTER confirmation
try {
  const fileCols = db.prepare("PRAGMA table_info(files)").all();
  let hasCallId = fileCols.some(c => c.name === 'call_id');
  if (!hasCallId) {
    console.log('⚙️  [MIGRATION] Adding call_id column to files');
    db.exec(`ALTER TABLE files ADD COLUMN call_id TEXT;`);
    hasCallId = true;
  }
  if (hasCallId) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_files_call_id ON files(call_id);`);
  }
} catch (e) {
  console.warn('⚠️  [MIGRATION] files.call_id migration/index issue:', e.message);
}

// Reporting table indexes (ensured after table creation earlier)
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reporting_timestamp ON reporting(timestamp);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reporting_agent ON reporting(agent);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reporting_campaign ON reporting(campaign);`);
} catch (e) {
  console.warn('⚠️  [MIGRATION] reporting index creation issue:', e.message);
}

// Migration: Normalize legacy Five9 timestamps to UTC ISO once on startup (batch processing)
try {
  const selectLegacy = db.prepare(`
    SELECT call_id, timestamp FROM reporting
    WHERE timestamp IS NOT NULL
      AND timestamp NOT GLOB '${ISO_TIMESTAMP_GLOB}'
    LIMIT ?
  `);
  const updateLegacy = db.prepare(`UPDATE reporting SET timestamp = ? WHERE call_id = ?`);
  const batchSize = parseInt(process.env.REPORTING_TIMESTAMP_MIGRATION_BATCH || '1000', 10);

  let totalConverted = 0;
  while (true) {
    const batch = selectLegacy.all(batchSize);
    if (!batch.length) break;
    const convertedThisBatch = db.transaction((rows) => {
      let converted = 0;
      for (const row of rows) {
        const normalized = normalizeReportTimestamp(row.timestamp);
        if (normalized && normalized !== row.timestamp) {
          updateLegacy.run(normalized, row.call_id);
          converted++;
        }
      }
      return converted;
    })(batch);
    totalConverted += convertedThisBatch;
    if (batch.length < batchSize) break;
    if (!convertedThisBatch) break;
  }
  if (totalConverted) {
    console.log(`🛠️  [MIGRATION] Normalized ${totalConverted} reporting timestamps to UTC ISO format`);
  }
  const remaining = getLegacyReportTimestampStats(5);
  if (remaining.total > 0) {
    console.warn(`⚠️  [MIGRATION] ${remaining.total} reporting rows still carry non-ISO timestamps (showing up to 5 samples).`);
    remaining.samples.forEach((row, idx) => {
      console.warn(`   [${idx + 1}] call_id=${row.call_id} timestamp="${row.timestamp}"`);
    });
  }
} catch (e) {
  console.warn('⚠️  [MIGRATION] reporting timestamp normalization issue:', e.message);
}

// Create audit logging tables
db.exec(`
  CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    session_duration_ms INTEGER,
    ip_address TEXT,
    user_agent TEXT,
    last_activity DATETIME
  );
`);

// --- Backward compatible migration: add last_activity if missing (older DBs) ---
try {
  const cols = db.prepare("PRAGMA table_info(user_sessions)").all();
  const hasLastActivity = cols.some(c => c.name === 'last_activity');
  if (!hasLastActivity) {
    console.log('⚙️  [MIGRATION] Adding last_activity column to user_sessions');
    db.exec(`ALTER TABLE user_sessions ADD COLUMN last_activity DATETIME;`);
    // Initialize existing rows to their login_time
    db.exec(`UPDATE user_sessions SET last_activity = login_time WHERE last_activity IS NULL;`);
  }
  // Ensure index for activity lookups
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_sessions_last_activity ON user_sessions(last_activity);`);
} catch (mErr) {
  console.warn('⚠️  [MIGRATION] last_activity migration issue (safe to ignore if already applied):', mErr.message);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    action_type TEXT NOT NULL, -- 'LOGIN', 'LOGOUT', 'PLAY_FILE', 'DOWNLOAD_FILE', 'VIEW_FILES'
    file_path TEXT, -- For file-related actions
    file_phone TEXT, -- Phone from file metadata
    file_email TEXT, -- Email from file metadata
    call_id TEXT, -- Call ID for file related events
    action_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    session_id TEXT,
    additional_data TEXT -- JSON string for extra context
  );
`);

// Create indexes for audit logs
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_login_time ON user_sessions(login_time);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user_email ON user_sessions(user_email);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(action_timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_email ON audit_logs(user_email);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_file_path ON audit_logs(file_path);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_composite ON audit_logs(user_id, action_type, action_timestamp);
`);

// Migration: ensure call_id column exists on audit_logs and index created after confirmation
try {
  const auditCols = db.prepare("PRAGMA table_info(audit_logs)").all();
  let auditHasCallId = auditCols.some(c => c.name === 'call_id');
  if (!auditHasCallId) {
    console.log('⚙️  [MIGRATION] Adding call_id column to audit_logs');
    db.exec(`ALTER TABLE audit_logs ADD COLUMN call_id TEXT;`);
    auditHasCallId = true;
  }
  if (auditHasCallId) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_call_id ON audit_logs(call_id);`);
  }
} catch (e) {
  console.warn('⚠️  [MIGRATION] audit_logs.call_id migration/index issue:', e.message);
}

// Prepared statements for performance
const statements = {
  // Insert or update file metadata
  upsertFile: db.prepare(`
    INSERT INTO files (file_path, phone, email, call_date, call_time, call_id, duration_ms, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      phone = excluded.phone,
      email = excluded.email,
      call_date = excluded.call_date,
      call_time = excluded.call_time,
      call_id = excluded.call_id,
      duration_ms = excluded.duration_ms,
      file_size = excluded.file_size,
      updated_at = CURRENT_TIMESTAMP
  `),
  
  // Get files with pagination and filtering
  getFiles: db.prepare(`
    SELECT 
      file_path,
      phone,
      email,
      call_date,
      call_time,
      call_id,
      duration_ms,
      file_size
    FROM files
    WHERE 1=1
      AND (? IS NULL OR call_date >= ?)
      AND (? IS NULL OR call_date <= ?)
      AND (? IS NULL OR phone LIKE '%' || ? || '%')
      AND (? IS NULL OR email LIKE '%' || ? || '%')
        AND (? IS NULL OR duration_ms >= ? * 1000)
        AND (? IS NULL OR call_time >= ?)
        AND (? IS NULL OR call_time <= ?)
        AND (? IS NULL OR call_id LIKE '%' || ? || '%')
    ORDER BY 
      CASE WHEN ? = 'date' AND ? = 'asc' THEN call_date END ASC,
      CASE WHEN ? = 'date' AND ? = 'desc' THEN call_date END DESC,
      CASE WHEN ? = 'time' AND ? = 'asc' THEN call_time END ASC,
      CASE WHEN ? = 'time' AND ? = 'desc' THEN call_time END DESC,
      CASE WHEN ? = 'phone' AND ? = 'asc' THEN phone END ASC,
      CASE WHEN ? = 'phone' AND ? = 'desc' THEN phone END DESC,
      CASE WHEN ? = 'email' AND ? = 'asc' THEN email END ASC,
      CASE WHEN ? = 'email' AND ? = 'desc' THEN email END DESC,
      CASE WHEN ? = 'durationMs' AND ? = 'asc' THEN duration_ms END ASC,
      CASE WHEN ? = 'durationMs' AND ? = 'desc' THEN duration_ms END DESC,
       CASE WHEN ? = 'callId' AND ? = 'asc' THEN call_id END ASC,
       CASE WHEN ? = 'callId' AND ? = 'desc' THEN call_id END DESC,
      call_date DESC, call_time DESC
    LIMIT ? OFFSET ?
  `),
  
  // Count total files matching filters
  countFiles: db.prepare(`
    SELECT COUNT(*) as total
    FROM files
    WHERE 1=1
      AND (? IS NULL OR call_date >= ?)
      AND (? IS NULL OR call_date <= ?)
      AND (? IS NULL OR phone LIKE '%' || ? || '%')
      AND (? IS NULL OR email LIKE '%' || ? || '%')
        AND (? IS NULL OR duration_ms >= ? * 1000)
        AND (? IS NULL OR call_time >= ?)
        AND (? IS NULL OR call_time <= ?)
        AND (? IS NULL OR call_id LIKE '%' || ? || '%')
  `),
  
  // Check if file exists
  fileExists: db.prepare('SELECT 1 FROM files WHERE file_path = ?'),
  
  // Delete file record
  deleteFile: db.prepare('DELETE FROM files WHERE file_path = ?'),
  
  // Get total file count
  getTotalCount: db.prepare('SELECT COUNT(*) as total FROM files'),
  // Rows needing backfill (missing call_id or zero/NULL duration)
  getFilesNeedingBackfill: db.prepare(`
    SELECT file_path FROM files
    WHERE (call_id IS NULL OR call_id = '')
       OR (duration_ms IS NULL OR duration_ms = 0)
    LIMIT ?
  `),
  updateFileParsedMeta: db.prepare(`
    UPDATE files
    SET call_id = ?, duration_ms = ?, updated_at = CURRENT_TIMESTAMP
    WHERE file_path = ?
  `),
  
  // Get files by date range for indexing
  getFilesByDateRange: db.prepare(`
    SELECT file_path FROM files 
    WHERE call_date >= ? AND call_date <= ?
  `),
  
  // Audit logging statements
  createUserSession: db.prepare(`
    INSERT INTO user_sessions (user_id, user_email, ip_address, user_agent, last_activity)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `),
  
  updateUserSession: db.prepare(`
    UPDATE user_sessions 
    SET logout_time = CURRENT_TIMESTAMP, 
        session_duration_ms = (strftime('%s', 'now') - strftime('%s', login_time)) * 1000
    WHERE user_id = ? AND logout_time IS NULL
  `),
  updateSessionActivity: db.prepare(`
    UPDATE user_sessions
    SET last_activity = CURRENT_TIMESTAMP
    WHERE user_id = ? AND logout_time IS NULL
  `),
  getInactiveOpenSessions: db.prepare(`
    SELECT id, user_id, user_email, login_time, last_activity, ip_address, user_agent
    FROM user_sessions
    WHERE logout_time IS NULL
      AND last_activity IS NOT NULL
      AND (strftime('%s','now') - strftime('%s', last_activity)) > (? * 60)
    LIMIT ?
  `),
  getAllOpenSessions: db.prepare(`
    SELECT id, user_id, user_email, login_time, last_activity
    FROM user_sessions
    WHERE logout_time IS NULL
    ORDER BY user_id, datetime(login_time) ASC, id ASC
  `),
  closeSessionById: db.prepare(`
    UPDATE user_sessions
    SET logout_time = ?,
        session_duration_ms = (strftime('%s', ?) - strftime('%s', login_time)) * 1000
    WHERE id = ? AND logout_time IS NULL
  `),
  forceExpireSessionById: db.prepare(`
    UPDATE user_sessions
    SET logout_time = CURRENT_TIMESTAMP,
        session_duration_ms = (strftime('%s','now') - strftime('%s', login_time)) * 1000
    WHERE id = ? AND logout_time IS NULL
  `),
  getExpiredOpenSessions: db.prepare(`
    SELECT id, user_id, user_email, login_time, ip_address, user_agent
    FROM user_sessions
    WHERE logout_time IS NULL
      AND (strftime('%s','now') - strftime('%s', login_time)) > (? * 3600)
    LIMIT ?
  `),
  
  createAuditLog: db.prepare(`
    INSERT INTO audit_logs (user_id, user_email, action_type, file_path, file_phone, file_email, call_id,
                           ip_address, user_agent, session_id, additional_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  
  getAuditLogs: db.prepare(`
    SELECT * FROM audit_logs 
    WHERE (? IS NULL OR user_id = ?)
      AND (? IS NULL OR action_type = ?)
      AND (? IS NULL OR DATE(action_timestamp) >= ?)
      AND (? IS NULL OR DATE(action_timestamp) <= ?)
      AND (? IS NULL OR call_id LIKE '%' || ? || '%')
    ORDER BY action_timestamp DESC 
    LIMIT ? OFFSET ?
  `),
  countAuditLogs: db.prepare(`
    SELECT COUNT(*) as total FROM audit_logs
    WHERE (? IS NULL OR user_id = ?)
      AND (? IS NULL OR action_type = ?)
      AND (? IS NULL OR DATE(action_timestamp) >= ?)
      AND (? IS NULL OR DATE(action_timestamp) <= ?)
      AND (? IS NULL OR call_id LIKE '%' || ? || '%')
  `),
  
  getUserSessions: db.prepare(`
    SELECT * FROM user_sessions 
    WHERE (? IS NULL OR user_id = ?)
      AND (? IS NULL OR DATE(login_time) >= ?)
      AND (? IS NULL OR DATE(login_time) <= ?)
    ORDER BY login_time DESC 
    LIMIT ? OFFSET ?
  `),
  
  getLastLogin: db.prepare(`
    SELECT login_time FROM user_sessions 
    WHERE user_id = ? 
    ORDER BY login_time DESC 
    LIMIT 1
  `),

  // Distinct users from audit_logs and user_sessions for autocomplete
  getDistinctUsers: db.prepare(`
    SELECT user_id, user_email FROM (
      SELECT user_id, user_email FROM audit_logs
      UNION ALL
      SELECT user_id, user_email FROM user_sessions
    )
    WHERE (? IS NULL OR user_email LIKE '%' || ? || '%' OR user_id LIKE '%' || ? || '%')
    GROUP BY user_id, user_email
    ORDER BY user_email
    LIMIT ?
  `),

  userUsageReport: db.prepare(`
    WITH filtered_audit AS (
      SELECT
        user_id,
        user_email,
        action_type,
        action_timestamp
      FROM audit_logs
      WHERE 1=1
        AND (? IS NULL OR DATE(action_timestamp) >= ?)
        AND (? IS NULL OR DATE(action_timestamp) <= ?)
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
      SELECT
        user_id,
        user_email,
        COALESCE(session_duration_ms, 0) AS session_duration_ms
      FROM user_sessions
      WHERE 1=1
        AND (? IS NULL OR DATE(login_time) >= ?)
        AND (? IS NULL OR DATE(login_time) <= ?)
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
      u.user_id AS user_id,
      COALESCE(audit_counts.user_email, session_totals.user_email) AS user_email,
      COALESCE(audit_counts.total_actions, 0) AS total_actions,
      COALESCE(audit_counts.login_count, 0) AS login_count,
      COALESCE(audit_counts.logout_count, 0) AS logout_count,
      COALESCE(audit_counts.play_count, 0) AS play_count,
      COALESCE(audit_counts.download_count, 0) AS download_count,
      COALESCE(audit_counts.view_count, 0) AS view_count,
      COALESCE(audit_counts.report_view_count, 0) AS report_view_count,
      COALESCE(audit_counts.report_download_count, 0) AS report_download_count,
      audit_counts.last_action_at AS last_action_at,
      COALESCE(session_totals.total_session_ms, 0) AS total_session_ms
    FROM combined_users u
    LEFT JOIN audit_counts ON audit_counts.user_id = u.user_id
    LEFT JOIN session_totals ON session_totals.user_id = u.user_id
    ORDER BY LOWER(COALESCE(audit_counts.user_email, session_totals.user_email)), u.user_id
  `)
};

statements.upsertReport = db.prepare(`
  INSERT INTO reporting (
    call_id,
    timestamp,
    campaign,
    call_type,
    agent,
    agent_name,
    disposition,
    ani,
    customer_name,
    dnis,
    call_time,
    bill_time_rounded,
    cost,
    ivr_time,
    queue_wait_time,
    ring_time,
    talk_time,
    hold_time,
    park_time,
    after_call_work_time,
    transfers,
    conferences,
    holds,
    abandoned,
    recordings,
    raw_json
  ) VALUES (
    @call_id,
    @timestamp,
    @campaign,
    @call_type,
    @agent,
    @agent_name,
    @disposition,
    @ani,
    @customer_name,
    @dnis,
    @call_time,
    @bill_time_rounded,
    @cost,
    @ivr_time,
    @queue_wait_time,
    @ring_time,
    @talk_time,
    @hold_time,
    @park_time,
    @after_call_work_time,
    @transfers,
    @conferences,
    @holds,
    @abandoned,
    @recordings,
    @raw_json
  )
  ON CONFLICT(call_id) DO UPDATE SET
    timestamp=excluded.timestamp,
    campaign=excluded.campaign,
    call_type=excluded.call_type,
    agent=excluded.agent,
    agent_name=excluded.agent_name,
    disposition=excluded.disposition,
    ani=excluded.ani,
    customer_name=excluded.customer_name,
    dnis=excluded.dnis,
    call_time=excluded.call_time,
    bill_time_rounded=excluded.bill_time_rounded,
    cost=excluded.cost,
    ivr_time=excluded.ivr_time,
    queue_wait_time=excluded.queue_wait_time,
    ring_time=excluded.ring_time,
    talk_time=excluded.talk_time,
    hold_time=excluded.hold_time,
    park_time=excluded.park_time,
    after_call_work_time=excluded.after_call_work_time,
    transfers=excluded.transfers,
    conferences=excluded.conferences,
    holds=excluded.holds,
    abandoned=excluded.abandoned,
    recordings=excluded.recordings,
    raw_json=excluded.raw_json;
`);
statements.queryReportsDesc = db.prepare(`
  SELECT * FROM reporting
  WHERE 1=1
    AND (? IS NULL OR timestamp >= ?)
    AND (? IS NULL OR timestamp <= ?)
    AND (? IS NULL OR agent LIKE '%' || ? || '%')
    AND (? IS NULL OR campaign = ?)
    AND (? IS NULL OR call_type = ?)
    AND (? IS NULL OR (ani LIKE '%' || ? || '%' OR dnis LIKE '%' || ? || '%'))
    AND (? IS NULL OR call_id LIKE '%' || ? || '%')
    AND (? IS NULL OR customer_name LIKE '%' || ? || '%')
    AND (? IS NULL OR after_call_work_time >= ?)
    AND (? IS NULL OR transfers = ?)
    AND (? IS NULL OR conferences = ?)
    AND (? IS NULL OR abandoned = ?)
  ORDER BY timestamp DESC
  LIMIT ? OFFSET ?;
`);
statements.queryReportsAsc = db.prepare(`
  SELECT * FROM reporting
  WHERE 1=1
    AND (? IS NULL OR timestamp >= ?)
    AND (? IS NULL OR timestamp <= ?)
    AND (? IS NULL OR agent LIKE '%' || ? || '%')
    AND (? IS NULL OR campaign = ?)
    AND (? IS NULL OR call_type = ?)
    AND (? IS NULL OR (ani LIKE '%' || ? || '%' OR dnis LIKE '%' || ? || '%'))
    AND (? IS NULL OR call_id LIKE '%' || ? || '%')
    AND (? IS NULL OR customer_name LIKE '%' || ? || '%')
    AND (? IS NULL OR after_call_work_time >= ?)
    AND (? IS NULL OR transfers = ?)
    AND (? IS NULL OR conferences = ?)
    AND (? IS NULL OR abandoned = ?)
  ORDER BY timestamp ASC
  LIMIT ? OFFSET ?;
`);
statements.countReports = db.prepare(`
  SELECT COUNT(*) as total FROM reporting
  WHERE 1=1
    AND (? IS NULL OR timestamp >= ?)
    AND (? IS NULL OR timestamp <= ?)
    AND (? IS NULL OR agent LIKE '%' || ? || '%')
    AND (? IS NULL OR campaign = ?)
    AND (? IS NULL OR call_type = ?)
    AND (? IS NULL OR (ani LIKE '%' || ? || '%' OR dnis LIKE '%' || ? || '%'))
    AND (? IS NULL OR call_id LIKE '%' || ? || '%')
    AND (? IS NULL OR customer_name LIKE '%' || ? || '%')
    AND (? IS NULL OR after_call_work_time >= ?)
    AND (? IS NULL OR transfers = ?)
    AND (? IS NULL OR conferences = ?)
    AND (? IS NULL OR abandoned = ?);
`);

// Test datetime filtering on startup to verify ISO timestamp handling
try {
  const testRow = db.prepare(`SELECT timestamp FROM reporting LIMIT 1`).get();
  if (testRow) {
    console.log(`[REPORTING] Sample timestamp from DB: "${testRow.timestamp}"`);
    const testDate = '2025-10-20T17:00:00.000Z';
    const testResult = db.prepare(`SELECT COUNT(*) as count FROM reporting WHERE datetime(timestamp) >= datetime(?)`).get(testDate);
    console.log(`[REPORTING] Test query with ${testDate}: ${testResult.count} rows match`);
  }
} catch (e) {
  console.warn('[REPORTING] Datetime test query failed:', e.message);
}

// Additional maintenance statements for backfilling missing call_id values on audit_logs
try {
  statements.getAuditLogsNeedingCallId = db.prepare(`
    SELECT id, additional_data FROM audit_logs
    WHERE call_id IS NULL
      AND additional_data IS NOT NULL
      AND (additional_data LIKE '%callId%' OR additional_data LIKE '%call_id%')
    LIMIT ?
  `);
  statements.updateAuditLogCallId = db.prepare(`
    UPDATE audit_logs SET call_id = ? WHERE id = ?
  `);
} catch (e) {
  console.warn('⚠️  [INIT] Failed to prepare audit call_id backfill statements:', e.message);
}

// Helper function to parse filename and extract metadata
export function parseFileMetadata(filePath) {
  const cleanFile = filePath.startsWith('recordings/') ? filePath.slice('recordings/'.length) : filePath;
  const [folder, filename] = cleanFile.split('/');
  
  if (!folder || !filename) return null;
  
  // Parse date from folder (M_D_YYYY -> YYYY-MM-DD)
  const dateParts = folder.split('_');
  if (dateParts.length !== 3) return null;
  
  const [month, day, year] = dateParts;
  const callDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  
  // Parse filename: {phone} by {email} @ {time}_{duration}.wav
  const phoneMatch = filename.match(/^(\d+)/);
  const phone = phoneMatch ? phoneMatch[1] : '';
  
  const emailMatch = filename.match(/by ([^@]+@[^ ]+)/);
  const email = emailMatch ? emailMatch[1] : '';
  
  const timeMatch = filename.match(/@ ([\d_]+ [AP]M)/);
  const timeStr = timeMatch ? timeMatch[1].replace(/_/g, ':') : '';
  
  // Convert to 24-hour format for database storage
  let callTime = '';
  if (timeStr) {
    try {
      const parsed = new Date(`1970-01-01 ${timeStr}`);
      if (!isNaN(parsed.getTime())) {
        callTime = parsed.toTimeString().slice(0, 8); // HH:MM:SS
      }
    } catch (e) {
      console.warn('Failed to parse time:', timeStr);
    }
  }
  
  // Precise pattern extraction: expect suffix "@ <HH_MM_SS AM|PM>_<duration>(_<callId>)?.wav"
  // Example: "@ 11_15_02 AM_2660_300000002997148.wav"
  let callId = null;
  let durationMs = 0;
  try {
    const suffixRegex = /@ ([0-9_]+ [AP]M)_(\d+)(?:_(\d+))?\.wav$/;
    const match = filename.match(suffixRegex);
    if (match) {
      const rawDuration = match[2];
      const rawCallId = match[3] || null;
      if (rawDuration && /^\d+$/.test(rawDuration)) {
        // Treat duration strictly as milliseconds as per requirement
        durationMs = parseInt(rawDuration, 10);
      }
      if (rawCallId && /^\d+$/.test(rawCallId)) callId = rawCallId;
    } else {
      // Fallback: legacy single duration
      const legacy = filename.match(/@ [0-9_]+ [AP]M_(\d+)\.wav$/);
      if (legacy) {
        const d = parseInt(legacy[1], 10);
        if (!isNaN(d)) durationMs = d;
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
    durationMs,
    fileSize: 0 // Will be updated when available
  };
}

// Index a single file
export function indexFile(filePath, fileSize = 0) {
  const metadata = parseFileMetadata(filePath);
  if (!metadata) return false;
  
  try {
    statements.upsertFile.run(
      metadata.filePath,
      metadata.phone,
      metadata.email,
      metadata.callDate,
      metadata.callTime,
      metadata.callId || null,
      metadata.durationMs,
      fileSize
    );
    return true;
  } catch (error) {
    console.error('Error indexing file:', filePath, error);
    return false;
  }
}

// Backfill any existing file rows missing call_id or duration_ms using current parsing logic
export function backfillFileMetadata(batchSize = 500) {
  let processed = 0;
  let updated = 0;
  for (;;) {
    const rows = statements.getFilesNeedingBackfill.all(batchSize);
    if (!rows.length) break;
    for (const row of rows) {
      processed++;
      const meta = parseFileMetadata(row.file_path);
      if (!meta) continue;
      try {
        statements.updateFileParsedMeta.run(meta.callId || null, meta.durationMs || 0, row.file_path);
        updated++;
      } catch (e) {
        console.warn('Backfill update failed for', row.file_path, e.message);
      }
    }
    if (rows.length < batchSize) break; // no more
  }
  return { processed, updated };
}

// Backfill audit_logs.call_id from additional_data JSON where missing
export function backfillAuditLogCallIds(batchSize = 500) {
  if (!statements.getAuditLogsNeedingCallId) {
    return { processed: 0, updated: 0, error: 'Statement not prepared' };
  }
  let processed = 0;
  let updated = 0;
  for (;;) {
    const rows = statements.getAuditLogsNeedingCallId.all(batchSize);
    if (!rows.length) break;
    for (const row of rows) {
      processed++;
      if (!row.additional_data) continue;
      try {
        const meta = JSON.parse(row.additional_data);
        const candidate = meta.callId || meta.call_id || null;
        if (candidate && /^\d+$/.test(String(candidate))) {
          statements.updateAuditLogCallId.run(String(candidate), row.id);
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

// Batch index multiple files (for initial indexing)
export function indexFiles(files) {
  const transaction = db.transaction((fileList) => {
    let indexed = 0;
    for (const file of fileList) {
      const filePath = typeof file === 'string' ? file : file.filePath;
      const fileSize = typeof file === 'object' ? file.fileSize : 0;
      
      if (indexFile(filePath, fileSize)) {
        indexed++;
      }
    }
    return indexed;
  });
  
  return transaction(files);
}

// Query files with advanced filtering and pagination
export function queryFiles(filters = {}) {
  const {
    dateStart,
    dateEnd,
    phone,
    email,
    durationMin,
    timeStart,
    timeEnd,
    callId,
    sortColumn = 'date',
    sortDirection = 'desc',
    limit = 25,
    offset = 0
  } = filters;
  
  // Convert date formats if needed
  const startDate = dateStart ? convertDateFormat(dateStart) : null;
  const endDate = dateEnd ? convertDateFormat(dateEnd) : null;
  
  // Prepare parameters for the query (in order of ? placeholders)
  const queryParams = [
    startDate, startDate,  // dateStart check (2 params)
    endDate, endDate,      // dateEnd check (2 params)
    phone, phone,          // phone filter (2 params)
    email, email,          // email filter (2 params)
    durationMin, durationMin, // duration filter (2 params)
    timeStart, timeStart,  // timeStart filter (2 params)
    timeEnd, timeEnd,      // timeEnd filter (2 params)
    callId, callId,        // call_id equality (2 params)
    // Sorting parameters (multiple for different combinations)
    sortColumn, sortDirection, // date sort
    sortColumn, sortDirection, // date sort desc
    sortColumn, sortDirection, // time sort
    sortColumn, sortDirection, // time sort desc
    sortColumn, sortDirection, // phone sort
    sortColumn, sortDirection, // phone sort desc
    sortColumn, sortDirection, // email sort
    sortColumn, sortDirection, // email sort desc
    sortColumn, sortDirection, // duration sort
    sortColumn, sortDirection, // duration sort desc
    sortColumn, sortDirection, // callId sort asc
    sortColumn, sortDirection, // callId sort desc
    limit, offset
  ];
  
  const files = statements.getFiles.all(...queryParams);
  
  // Get total count with same filters
  const countParams = [
    startDate, startDate,
    endDate, endDate,
    phone, phone,
    email, email,
    durationMin, durationMin,
    timeStart, timeStart,
    timeEnd, timeEnd,
    callId, callId
  ];
  
  const { total } = statements.countFiles.get(...countParams);
  
  return {
    files: files.map(f => ({
      file_path: f.file_path,
      phone: f.phone,
      email: f.email,
      call_date: f.call_date,
      call_time: f.call_time,
      call_id: f.call_id || null,
      duration_ms: f.duration_ms,
      file_size: f.file_size
    })),
    totalCount: total,
    hasMore: offset + limit < total
  };
}

// Helper function to convert M_D_YYYY to YYYY-MM-DD
function convertDateFormat(dateStr) {
  if (!dateStr) return null;
  
  if (dateStr.includes('_')) {
    // Convert M_D_YYYY to YYYY-MM-DD
    const [month, day, year] = dateStr.split('_');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  
  return dateStr; // Already in correct format
}

// Check database stats
export function getDatabaseStats() {
  try {
    const { total } = statements.getTotalCount.get();
    const databaseSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    
    return {
      totalFiles: total || 0,
      databasePath: DB_PATH,
      databaseSize: databaseSize
    };
  } catch (error) {
    console.error('Error getting database stats:', error);
    return {
      totalFiles: 0,
      databasePath: DB_PATH,
      databaseSize: 0
    };
  }
}

// Audit logging functions
export function logUserSession(userId, userEmail, ipAddress, userAgent) {
  try {
    const result = statements.createUserSession.run(userId, userEmail, ipAddress, userAgent);
    console.log(`📋 [AUDIT] User session created for ${userEmail} (ID: ${userId})`);
    return result.lastInsertRowid;
  } catch (error) {
    console.error('Error creating user session:', error);
    return null;
  }
}

export function logUserLogout(userId) {
  try {
    statements.updateUserSession.run(userId);
    console.log(`📋 [AUDIT] User session ended for ${userId}`);
  } catch (error) {
    console.error('Error updating user session:', error);
  }
}

export function touchUserSession(userId) {
  try {
    statements.updateSessionActivity.run(userId);
  } catch (error) {
    console.error('Error updating session activity:', error);
  }
}

export function expireStaleSessions(maxHours = 4, batchLimit = 100) {
  try {
    const rows = statements.getExpiredOpenSessions.all(maxHours, batchLimit);
    if (!rows.length) return 0;
    const ids = rows.map(r => r.id);
    for (const row of rows) {
      statements.forceExpireSessionById.run(row.id);
    }
    return rows;
  } catch (e) {
    console.error('Error expiring sessions:', e);
    return 0;
  }
}

export function logAuditEvent(userId, userEmail, actionType, filePath = null, fileMetadata = null, ipAddress = null, userAgent = null, sessionId = null, additionalData = null) {
  try {
    const filePhone = fileMetadata?.phone || null;
    const fileEmail = fileMetadata?.email || null;
    const additionalDataStr = additionalData ? JSON.stringify(additionalData) : null;
    const callId = fileMetadata?.callId || fileMetadata?.call_id || additionalData?.callId || null;
    
    statements.createAuditLog.run(
      userId,
      userEmail,
      actionType,
      filePath,
      filePhone,
      fileEmail,
      callId,
      ipAddress,
      userAgent,
      sessionId,
      additionalDataStr
    );
    
    console.log(`📋 [AUDIT] ${actionType} logged for ${userEmail}${filePath ? ` - File: ${filePath}` : ''}`);
  } catch (error) {
    console.error('Error creating audit log:', error);
  }
}

export function getAuditLogs(userId = null, actionType = null, startDate = null, endDate = null, callId = null, limit = 100, offset = 0) {
  try {
    const rows = statements.getAuditLogs.all(
      userId, userId,
      actionType, actionType,
      startDate, startDate,
      endDate, endDate,
      callId, callId,
      limit, offset
    );
    const { total } = statements.countAuditLogs.get(
      userId, userId,
      actionType, actionType,
      startDate, startDate,
      endDate, endDate,
      callId, callId
    );
    return { rows, total };
  } catch (error) {
    console.error('Error getting audit logs:', error);
    return { rows: [], total: 0 };
  }
}

export function getCallIdsWithRecordings(callIds = []) {
  if (!Array.isArray(callIds) || !callIds.length) return {};
  const seen = new Set();
  const unique = [];
  for (const id of callIds) {
    if (!id) continue;
    const key = String(id);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  if (!unique.length) return {};

  const MAX_PARAMS = 999;
  const result = {};

  for (let i = 0; i < unique.length; i += MAX_PARAMS) {
    const chunk = unique.slice(i, i + MAX_PARAMS);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT DISTINCT call_id FROM files WHERE call_id IN (${placeholders})`);
    try {
      const rows = stmt.all(...chunk);
      for (const row of rows) {
        if (row?.call_id) {
          result[row.call_id] = true;
        }
      }
    } catch (err) {
      console.warn('[DB] getCallIdsWithRecordings query failed:', err.message);
    }
  }

  return result;
}

export function exportAuditLogs(filters = {}, maxRows = AUDIT_EXPORT_MAX_ROWS) {
  const {
    userId = null,
    actionType = null,
    startDate = null,
    endDate = null,
    callId = null
  } = filters;

  try {
    const { total } = statements.countAuditLogs.get(
      userId, userId,
      actionType, actionType,
      startDate, startDate,
      endDate, endDate,
      callId, callId
    );

    if (total > maxRows) {
      return { rows: [], total, truncated: true, maxRows };
    }

    const rows = [];
    const chunkSize = 500;
    let offset = 0;

    while (offset < total) {
      const chunk = statements.getAuditLogs.all(
        userId, userId,
        actionType, actionType,
        startDate, startDate,
        endDate, endDate,
        callId, callId,
        chunkSize,
        offset
      );

      if (!chunk.length) break;
      rows.push(...chunk);
      offset += chunk.length;
    }

    return { rows, total, truncated: false, maxRows };
  } catch (error) {
    console.error('Error exporting audit logs:', error);
    return { rows: [], total: 0, truncated: false, maxRows, error: error.message };
  }
}

export function getUserSessions(userId = null, startDate = null, endDate = null, limit = 100, offset = 0) {
  try {
    return statements.getUserSessions.all(
      userId, userId,
      startDate, startDate,
      endDate, endDate,
      limit, offset
    );
  } catch (error) {
    console.error('Error getting user sessions:', error);
    return [];
  }
}

export function getUserUsageReport(startDate = null, endDate = null) {
  try {
    const rows = statements.userUsageReport.all(
      startDate, startDate,
      endDate, endDate,
      startDate, startDate,
      endDate, endDate
    );

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

export function exportUserUsageReport(startDate = null, endDate = null, maxRows = USER_USAGE_EXPORT_MAX_ROWS) {
  const rows = getUserUsageReport(startDate, endDate);
  if (rows.length > maxRows) {
    return { rows: [], total: rows.length, truncated: true, maxRows };
  }
  return { rows, total: rows.length, truncated: false, maxRows };
}

export function getLastLogin(userId) {
  try {
    const result = statements.getLastLogin.get(userId);
    return result?.login_time || null;
  } catch (error) {
    console.error('Error getting last login:', error);
    return null;
  }
}

export function expireInactiveSessions(maxInactivityMinutes = 30, batchLimit = 200) {
  try {
    const rows = statements.getInactiveOpenSessions.all(maxInactivityMinutes, batchLimit);
    if (!rows.length) return 0;
    for (const row of rows) {
      statements.forceExpireSessionById?.run?.(row.id); // reuse if added earlier; fallback to updateUserSession logic per user
      if (!statements.forceExpireSessionById) {
        // fallback closes all open sessions for that user
        statements.updateUserSession.run(row.user_id);
      }
    }
    return rows;
  } catch (e) {
    console.error('Error expiring inactive sessions:', e);
    return 0;
  }
}

export function repairOpenSessions({ keepLatestOpen = true } = {}) {
  try {
    const open = statements.getAllOpenSessions.all();
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
      // sessions are already sorted by login_time ASC
      for (let i = 0; i < sessions.length; i++) {
        const sess = sessions[i];
        const next = sessions[i + 1];
        const isLast = i === sessions.length - 1;
        if (isLast && keepLatestOpen) continue; // keep the most recent session open
        let logoutTime = next ? next.login_time : new Date().toISOString();
        // Ensure logoutTime > login_time
        if (new Date(logoutTime).getTime() <= new Date(sess.login_time).getTime()) {
          logoutTime = new Date(new Date(sess.login_time).getTime() + 1000).toISOString();
        }
        statements.closeSessionById.run(logoutTime, logoutTime, sess.id);
        sessionsClosed++;
        details.push({ sessionId: sess.id, userId, closedAt: logoutTime, login_time: sess.login_time });
      }
    }
    return { usersAffected: details.reduce((acc, d) => acc.add(d.userId), new Set()).size, sessionsClosed, details };
  } catch (e) {
    console.error('Error repairing sessions:', e);
    return { usersAffected: 0, sessionsClosed: 0, details: [], error: e.message };
  }
}

// Retroactively close any open sessions whose age exceeds maxHours, synthesizing a realistic logout_time
// Instead of marking logout_time as NOW (which would create inflated durations), we set logout_time = login_time + maxHours.
// Returns { closed: number, details: [] }
export function backfillExpiredOpenSessions(maxHours = 4) {
  try {
    // Reuse existing query logic to find expired sessions (but we need all, not limited artificially)
    // We'll craft a direct query to avoid the LIMIT in prepared statement getExpiredOpenSessions
    const rows = db.prepare(`
      SELECT id, user_id, user_email, login_time
      FROM user_sessions
      WHERE logout_time IS NULL
        AND (strftime('%s','now') - strftime('%s', login_time)) > (? * 3600)
      ORDER BY datetime(login_time) ASC
    `).all(maxHours);
    if (!rows.length) return { closed: 0, details: [] };
    const details = [];
    for (const row of rows) {
      const syntheticLogout = new Date(new Date(row.login_time).getTime() + maxHours * 3600 * 1000).toISOString();
      // Ensure synthetic logout does not exceed now (in case clock skew)
      const nowIso = new Date().toISOString();
      const finalLogout = syntheticLogout > nowIso ? nowIso : syntheticLogout;
      statements.closeSessionById.run(finalLogout, finalLogout, row.id);
      details.push({ sessionId: row.id, userId: row.user_id, login_time: row.login_time, logout_time: finalLogout });
    }
    return { closed: details.length, details };
  } catch (e) {
    console.error('Error backfilling expired open sessions:', e);
    return { closed: 0, details: [], error: e.message };
  }
}

export function getDistinctUsers(search = null, limit = 20) {
  try {
    const term = search && search.trim() !== '' ? search.trim() : null;
    return statements.getDistinctUsers.all(term, term, term, limit);
  } catch (error) {
    console.error('Error getting distinct users:', error);
    return [];
  }
}

// ----------------------------------------------
// Reporting helpers
// ----------------------------------------------
export function upsertReportRow(row) {
  try {
    const normalizedRow = { ...row };
    const normalizedTs = normalizeReportTimestamp(normalizedRow.timestamp);
    if (normalizedTs) normalizedRow.timestamp = normalizedTs;
    statements.upsertReport.run(normalizedRow);
    return true;
  } catch (e) {
    console.error('Failed to upsert report row', e.message, row?.call_id);
    return false;
  }
}

export function bulkUpsertReports(rows = []) {
  const tx = db.transaction((items) => {
    let inserted = 0;
    for (const r of items) {
      const normalizedRow = { ...r };
      const normalizedTs = normalizeReportTimestamp(normalizedRow.timestamp);
      if (normalizedTs) normalizedRow.timestamp = normalizedTs;
      try { statements.upsertReport.run(normalizedRow); inserted++; } catch { /* ignore duplicate errors */ }
    }
    return inserted;
  });
  return tx(rows);
}

export function queryReports({ start=null, end=null, agent=null, campaign=null, callType=null, phone=null, callId=null, customerName=null, afterCallWork=null, transfers=null, conferences=null, abandoned=null, limit=100, offset=0, sort='desc' } = {}) {
  try {
    const norm = v => (v && typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
    const normLike = (v) => {
      if (v === null || v === undefined) return null;
      const str = String(v).trim();
      return str === '' ? null : str;
    };
    const normDuration = (v) => {
      if (v === null || v === undefined) return null;
      const num = Number(v);
      if (!Number.isFinite(num)) return null;
      if (num < 0) return null;
      return Math.floor(num);
    };
    const normBinary = (v) => {
      if (v === null || v === undefined) return null;
      const num = Number(v);
      if (!Number.isFinite(num)) return null;
      if (num === 0 || num === 1) return num;
      return null;
    };
    const s = norm(start);
    const e = norm(end);
    const a = norm(agent);
    const c = norm(campaign);
    const ct = norm(callType);
    const phoneNorm = normLike(phone);
    const ci = normLike(callId);
    const cust = normLike(customerName);
    const acw = normDuration(afterCallWork);
    const tr = normBinary(transfers);
    const conf = normBinary(conferences);
    const ab = normBinary(abandoned);
    const sortDir = sort === 'asc' ? 'asc' : 'desc';
    console.log(`[QUERY REPORTS] Filters: start=${s}, end=${e}, agent=${a}, campaign=${c}, callType=${ct}, phone=${phoneNorm}, callId=${ci}, customer=${cust}, afterCallWorkMin=${acw}, transfers=${tr}, conferences=${conf}, abandoned=${ab}, limit=${limit}, offset=${offset}, sort=${sortDir}`);
    const stmt = sortDir === 'asc' ? statements.queryReportsAsc : statements.queryReportsDesc;
    const rows = stmt.all(s, s, e, e, a, a, c, c, ct, ct, phoneNorm, phoneNorm, phoneNorm, ci, ci, cust, cust, acw, acw, tr, tr, conf, conf, ab, ab, limit, offset);
    const { total } = statements.countReports.get(s, s, e, e, a, a, c, c, ct, ct, phoneNorm, phoneNorm, phoneNorm, ci, ci, cust, cust, acw, acw, tr, tr, conf, conf, ab, ab);
    console.log(`[QUERY REPORTS] Results: returned ${rows.length} rows, total=${total}`);
    if (rows.length > 0) {
      console.log(`[QUERY REPORTS] First row timestamp: ${rows[0].timestamp}, Last row timestamp: ${rows[rows.length-1].timestamp}`);
    }
    return { rows, total, sort: sortDir };
  } catch (e) {
    console.error('Failed to query reports', e);
    return { rows: [], total: 0 };
  }
}

// Debug summary for reporting (min/max timestamps & total rows) -- used by an optional endpoint
export function getReportingSummary() {
  try {
    const row = db.prepare(`SELECT COUNT(*) as total, MIN(timestamp) as minTs, MAX(timestamp) as maxTs FROM reporting`).get();
    return row || { total:0, minTs:null, maxTs:null };
  } catch (e) {
    return { total:0, minTs:null, maxTs:null, error: e.message };
  }
}

export function getDistinctCampaigns() {
  try { return db.prepare(`SELECT DISTINCT campaign FROM reporting WHERE campaign IS NOT NULL AND campaign <> '' ORDER BY campaign`).all().map(r=>r.campaign); } catch { return []; }
}
export function getDistinctCallTypes() {
  try { return db.prepare(`SELECT DISTINCT call_type FROM reporting WHERE call_type IS NOT NULL AND call_type <> '' ORDER BY call_type`).all().map(r=>r.call_type); } catch { return []; }
}

export function rewriteReportTimestamps({ batchSize = 5000, runAll = true, includeIso = false, dryRun = false } = {}) {
  const selectLegacyStmt = db.prepare(`
    SELECT rowid AS rid, call_id, timestamp FROM reporting
    WHERE rowid > ? AND timestamp IS NOT NULL AND timestamp NOT GLOB '${ISO_TIMESTAMP_GLOB}'
    ORDER BY rowid ASC
    LIMIT ?
  `);
  const selectAllStmt = db.prepare(`
    SELECT rowid AS rid, call_id, timestamp FROM reporting
    WHERE rowid > ? AND timestamp IS NOT NULL
    ORDER BY rowid ASC
    LIMIT ?
  `);
  const selectStmt = includeIso ? selectAllStmt : selectLegacyStmt;
  const updateStmt = dryRun ? null : db.prepare(`UPDATE reporting SET timestamp = ? WHERE call_id = ?`);

  let processed = 0;
  let updated = 0;
  let errors = 0;
  let batches = 0;
  let lastRowId = 0;
  const conversions = [];

  while (true) {
    const rows = selectStmt.all(lastRowId, batchSize);
    if (!rows.length) break;
    batches++;
    processed += rows.length;

    const updates = [];
    for (const row of rows) {
      try {
        const normalized = normalizeReportTimestamp(row.timestamp);
        if (!normalized) {
          errors++;
          if (REPORT_TIME_DEBUG && errors <= 5) {
            console.warn(`[REPORT_TIME] Failed to normalize call_id=${row.call_id} timestamp="${row.timestamp}"`);
          }
          continue;
        }
        if (normalized !== row.timestamp) {
          updates.push({ callId: row.call_id, from: row.timestamp, to: normalized });
        }
      } catch (e) {
        errors++;
        if (REPORT_TIME_DEBUG && errors <= 5) {
          console.warn(`[REPORT_TIME] Exception normalizing call_id=${row.call_id}: ${e.message}`);
        }
      }
    }

    if (!dryRun && updates.length) {
      db.transaction((items) => {
        for (const item of items) {
          updateStmt.run(item.to, item.callId);
        }
      })(updates);
    }

    if (updates.length) {
      updated += updates.length;
      const spaceRemaining = 5 - conversions.length;
      if (spaceRemaining > 0) {
        conversions.push(...updates.slice(0, spaceRemaining));
      }
    }

    lastRowId = rows[rows.length - 1].rid;
    if (!runAll || rows.length < batchSize) break;
  }

  const legacy = getLegacyReportTimestampStats(5);
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

export function getLegacyReportTimestampStats(limit = 10) {
  try {
    const totalRow = db.prepare(`
      SELECT COUNT(*) as count FROM reporting
      WHERE timestamp IS NOT NULL AND timestamp NOT GLOB '${ISO_TIMESTAMP_GLOB}'
    `).get();
    const samples = db.prepare(`
      SELECT call_id, timestamp FROM reporting
      WHERE timestamp IS NOT NULL AND timestamp NOT GLOB '${ISO_TIMESTAMP_GLOB}'
      ORDER BY rowid DESC
      LIMIT ?
    `).all(limit);
    return { total: totalRow?.count || 0, samples };
  } catch (e) {
    if (REPORT_TIME_DEBUG) console.warn('[REPORT_TIME] Legacy timestamp stats failed:', e.message);
    return { total: 0, samples: [], error: e.message };
  }
}

export { db, statements };
export default db;