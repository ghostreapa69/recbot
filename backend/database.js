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

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_timestamp ON reporting(timestamp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_timestamp_desc ON reporting(timestamp DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_agent ON reporting(agent);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_agent_name ON reporting(agent_name);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_campaign ON reporting(campaign);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_call_type ON reporting(call_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_ani ON reporting(ani);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_dnis ON reporting(dnis);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_customer_name ON reporting(customer_name);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reporting_disposition ON reporting(disposition);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_call_disposition ON files(call_disposition);`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_login_time ON user_sessions(login_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_email ON user_sessions(user_email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_last_activity ON user_sessions(last_activity);`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(action_timestamp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_email ON audit_logs(user_email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_file_path ON audit_logs(file_path);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_composite ON audit_logs(user_id, action_type, action_timestamp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_call_id ON audit_logs(call_id);`);

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
    await client.query('ROLLBACK');
    console.error('Error in indexFiles transaction:', error);
    return 0;
  } finally {
    client.release();
  }
}

// ============================================================
// File queries
// ============================================================
export async function queryFiles(filters = {}) {
  const {
    dateStart,
    dateEnd,
    phone,
    email,
    durationMin,
    timeStart,
    timeEnd,
    callId,
    callDisposition,
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
  if (timeStart) { conditions.push(`call_time >= $${paramIdx++}`); params.push(timeStart); }
  if (timeEnd) { conditions.push(`call_time <= $${paramIdx++}`); params.push(timeEnd); }
  if (callId) { conditions.push(`call_id LIKE '%' || $${paramIdx++} || '%'`); params.push(callId); }
  if (callDisposition) { conditions.push(`call_disposition = $${paramIdx++}`); params.push(callDisposition); }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Build ORDER BY
  const sortMap = {
    date: 'call_date',
    time: 'call_time',
    phone: 'phone',
    email: 'email',
    durationMs: 'duration_ms',
    callId: 'call_id',
    callDisposition: 'call_disposition'
  };
  const sortCol = sortMap[sortColumn] || 'call_date';
  const sortDir = sortDirection === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `ORDER BY ${sortCol} ${sortDir}, call_date DESC, call_time DESC`;

  const limitParam = `$${paramIdx++}`;
  const offsetParam = `$${paramIdx++}`;
  params.push(limit, offset);

  const dataQuery = `
    SELECT file_path, phone, email, call_date, call_time, call_id, call_disposition, duration_ms, file_size
    FROM files ${whereClause}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  // Count query (same conditions, no limit/offset)
  const countParams = params.slice(0, params.length - 2);
  const countQuery = `SELECT COUNT(*) as total FROM files ${whereClause}`;

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
      file_size: f.file_size
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
// Audit logging
// ============================================================
export async function logUserSession(userId, userEmail, ipAddress, userAgent) {
  try {
    const result = await pool.query(`
      INSERT INTO user_sessions (user_id, user_email, ip_address, user_agent, last_activity)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id
    `, [userId, userEmail, ipAddress, userAgent]);
    console.log(`📋 [AUDIT] User session created for ${userEmail} (ID: ${userId})`);
    return result.rows[0].id;
  } catch (error) {
    console.error('Error creating user session:', error);
    return null;
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
    await client.query('ROLLBACK');
    console.error('Failed to bulk upsert reports:', e);
    return 0;
  } finally {
    client.release();
  }
}

function buildReportWhereClause(params, { start, end, agent, agentName, campaign, callType, disposition, phone, callId, customerName, afterCallWork, transfers, conferences, abandoned }, { alias = '' } = {}) {
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
  if (phone) { conditions.push(`(${p}ani LIKE '%' || $${paramIdx} || '%' OR ${p}dnis LIKE '%' || $${paramIdx} || '%')`); params.push(phone); paramIdx++; }
  if (callId) { conditions.push(`${p}call_id LIKE '%' || $${paramIdx++} || '%'`); params.push(callId); }
  if (customerName) { conditions.push(`${p}customer_name LIKE '%' || $${paramIdx++} || '%'`); params.push(customerName); }
  if (afterCallWork !== null && afterCallWork !== undefined) { conditions.push(`${p}after_call_work_time >= $${paramIdx++}`); params.push(afterCallWork); }
  if (transfers !== null && transfers !== undefined) { conditions.push(`${p}transfers = $${paramIdx++}`); params.push(transfers); }
  if (conferences !== null && conferences !== undefined) { conditions.push(`${p}conferences = $${paramIdx++}`); params.push(conferences); }
  if (abandoned !== null && abandoned !== undefined) { conditions.push(`${p}abandoned = $${paramIdx++}`); params.push(abandoned); }

  return conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
}

export async function queryReports({ start = null, end = null, agent = null, agentName = null, campaign = null, callType = null, disposition = null, phone = null, callId = null, customerName = null, afterCallWork = null, transfers = null, conferences = null, abandoned = null, limit = 100, offset = 0, sort = 'desc' } = {}) {
  try {
    const norm = v => (v && typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
    const normLike = (v) => { if (v === null || v === undefined) return null; const str = String(v).trim(); return str === '' ? null : str; };
    const normDuration = (v) => { if (v === null || v === undefined) return null; const num = Number(v); if (!Number.isFinite(num) || num < 0) return null; return Math.floor(num); };
    const normBinary = (v) => { if (v === null || v === undefined) return null; const num = Number(v); if (!Number.isFinite(num)) return null; if (num === 0 || num === 1) return num; return null; };

    const s = norm(start), e = norm(end), a = norm(agent), aName = norm(agentName);
    const c = norm(campaign), ct = norm(callType), disp = norm(disposition);
    const phoneNorm = normLike(phone), ci = normLike(callId), cust = normLike(customerName);
    const acw = normDuration(afterCallWork), tr = normBinary(transfers), conf = normBinary(conferences), ab = normBinary(abandoned);
    const sortDir = sort === 'asc' ? 'ASC' : 'DESC';

    console.log(`[QUERY REPORTS] Filters: start=${s}, end=${e}, agent=${a}, agentName=${aName}, campaign=${c}, callType=${ct}, phone=${phoneNorm}, callId=${ci}, customer=${cust}, afterCallWorkMin=${acw}, transfers=${tr}, conferences=${conf}, abandoned=${ab}, limit=${limit}, offset=${offset}, sort=${sortDir}`);

    const filterArgs = {
      start: s, end: e, agent: a, agentName: aName, campaign: c, callType: ct,
      disposition: disp, phone: phoneNorm, callId: ci, customerName: cust,
      afterCallWork: acw, transfers: tr, conferences: conf, abandoned: ab
    };

    // Build WHERE clause with "r." alias for the JOIN query
    const dataParams = [];
    const joinWhereClause = buildReportWhereClause(dataParams, filterArgs, { alias: 'r' });

    // Build a second WHERE clause without alias for the COUNT query
    const countParams = [];
    const countWhereClause = buildReportWhereClause(countParams, filterArgs);

    const paramIdx = dataParams.length + 1;
    dataParams.push(limit, offset);

    // Explicit column list — exclude raw_json (large TEXT blob, only needed for hydration
    // which we now do selectively) and recordings (rarely needed in list views).
    // LEFT JOIN files to compute hasRecording in-query instead of a separate round-trip.
    const reportCols = `r.call_id, r.timestamp, r.campaign, r.call_type, r.agent, r.agent_name,
      r.disposition, r.ani, r.customer_name, r.dnis, r.call_time, r.bill_time_rounded,
      r.cost, r.ivr_time, r.queue_wait_time, r.ring_time, r.talk_time, r.hold_time,
      r.park_time, r.after_call_work_time, r.transfers, r.conferences, r.holds,
      r.abandoned, r.created_at,
      CASE WHEN f.call_id IS NOT NULL THEN true ELSE false END AS "hasRecording"`;

    const dataQuery = `SELECT ${reportCols}
      FROM reporting r
      LEFT JOIN (SELECT DISTINCT call_id FROM files WHERE call_id IS NOT NULL) f ON f.call_id = r.call_id
      ${joinWhereClause}
      ORDER BY r.timestamp ${sortDir} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    const countQuery = `SELECT COUNT(*) as total FROM reporting ${countWhereClause}`;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      pool.query(countQuery, countParams)
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    console.log(`[QUERY REPORTS] Results: returned ${dataResult.rows.length} rows, total=${total}`);
    return { rows: dataResult.rows, total, sort: sort === 'asc' ? 'asc' : 'desc' };
  } catch (e) {
    console.error('Failed to query reports', e);
    return { rows: [], total: 0 };
  }
}

export async function exportReports({ start = null, end = null, agent = null, agentName = null, campaign = null, callType = null, disposition = null, phone = null, callId = null, customerName = null, afterCallWork = null, transfers = null, conferences = null, abandoned = null, sort = 'desc' } = {}, maxRows = REPORT_EXPORT_MAX_ROWS) {
  try {
    const norm = v => (v && typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
    const normLike = (v) => { if (v === null || v === undefined) return null; const str = String(v).trim(); return str === '' ? null : str; };
    const normDuration = (v) => { if (v === null || v === undefined) return null; const num = Number(v); if (!Number.isFinite(num) || num < 0) return null; return Math.floor(num); };
    const normBinary = (v) => { if (v === null || v === undefined) return null; const num = Number(v); if (!Number.isFinite(num)) return null; if (num === 0 || num === 1) return num; return null; };

    const s = norm(start), e = norm(end), a = norm(agent), aName = norm(agentName);
    const c = norm(campaign), ct = norm(callType), disp = norm(disposition);
    const phoneNorm = normLike(phone), ci = normLike(callId), cust = normLike(customerName);
    const acw = normDuration(afterCallWork), tr = normBinary(transfers), conf = normBinary(conferences), ab = normBinary(abandoned);
    const sortDir = sort === 'asc' ? 'ASC' : 'DESC';

    const params = [];
    const whereClause = buildReportWhereClause(params, {
      start: s, end: e, agent: a, agentName: aName, campaign: c, callType: ct,
      disposition: disp, phone: phoneNorm, callId: ci, customerName: cust,
      afterCallWork: acw, transfers: tr, conferences: conf, abandoned: ab
    });

    const countResult = await pool.query(`SELECT COUNT(*) as total FROM reporting ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].total, 10);

    if (total > maxRows) {
      return { rows: [], total, truncated: true, maxRows, sort: sort === 'asc' ? 'asc' : 'desc' };
    }

    const dataResult = await pool.query(
      `SELECT * FROM reporting ${whereClause} ORDER BY timestamp ${sortDir}`,
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

export async function getDistinctCampaigns() {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT campaign FROM reporting WHERE campaign IS NOT NULL AND campaign <> '' ORDER BY campaign`);
    return rows.map(r => r.campaign);
  } catch { return []; }
}

export async function getDistinctCallTypes() {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT call_type FROM reporting WHERE call_type IS NOT NULL AND call_type <> '' ORDER BY call_type`);
    return rows.map(r => r.call_type);
  } catch { return []; }
}

export async function getDistinctDispositions() {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT disposition FROM reporting WHERE disposition IS NOT NULL AND disposition <> '' ORDER BY disposition`);
    return rows.map(r => r.disposition);
  } catch { return []; }
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
// Export pool for direct queries (used by debug endpoints in index.js)
// ============================================================
export { pool };
export default pool;
