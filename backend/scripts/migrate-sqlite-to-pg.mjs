#!/usr/bin/env node
// ============================================================
// SQLite → PostgreSQL Migration (COPY Protocol)
// ============================================================
//
// Uses PostgreSQL COPY FROM STDIN — the fastest data path into PG.
// This bypasses the SQL parser, query planner, and per-row overhead.
// Typical throughput: 100,000–500,000+ rows/sec.
//
// Additional optimizations:
//   • SQLite rowid cursor — O(batch) per read, not O(offset)
//   • All constraints & indexes dropped before load, rebuilt after
//   • PG session tuned for bulk: synchronous_commit=off, high work_mem
//   • Tables truncated before load — no conflict checking needed
//
// Usage:
//   node scripts/migrate-sqlite-to-pg.mjs /path/to/recbot.db
//
// Safe to re-run: truncates PG tables and reloads from SQLite.
// ============================================================

import { createRequire } from 'module';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import fs from 'fs';
import pg from 'pg';

const require = createRequire(import.meta.url);

// ── Load native/optional dependencies ───────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('❌ better-sqlite3 is not installed.');
  console.error('   npm install better-sqlite3');
  process.exit(1);
}

let copyFrom;
try {
  ({ from: copyFrom } = require('pg-copy-streams'));
} catch (e) {
  console.error('❌ pg-copy-streams is not installed.');
  console.error('   npm install pg-copy-streams');
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────
const SQLITE_PATH = process.argv[2];
if (!SQLITE_PATH) {
  console.error('Usage: node scripts/migrate-sqlite-to-pg.mjs <path-to-recbot.db>');
  process.exit(1);
}
if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`❌ SQLite file not found: ${SQLITE_PATH}`);
  process.exit(1);
}

// Rows per SQLite read. Uses rowid cursor so each read is always O(batch).
// 50K is a good balance: fast reads, ~5–50 MB per text buffer depending on row size.
const READ_BATCH = 50_000;

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'recbot',
  user: process.env.DB_USER || 'recbot',
  password: process.env.DB_PASSWORD || 'recbot',
  max: 3,
});

// ── COPY text-format escaping ───────────────────────────────
// PG COPY text format rules: \N = NULL, \\ = backslash, \t = tab, \n = newline, \r = CR
function esc(value) {
  if (value === null || value === undefined) return '\\N';
  const s = String(value);
  if (s.length === 0) return s;
  // Fast path: skip regex if no special characters
  if (!s.includes('\\') && !s.includes('\t') && !s.includes('\n') && !s.includes('\r')) return s;
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// ── Formatting helpers ──────────────────────────────────────
function dur(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${rs}s`;
}
const fmt = n => Number(n).toLocaleString('en-US');

// ── SQLite helpers ──────────────────────────────────────────
function tableExists(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}
function getColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}
function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
}

// ── Schema definitions ──────────────────────────────────────
// Constraints to drop before bulk load and recreate after
const CONSTRAINTS = [
  { table: 'files',         name: 'files_pkey',          drop: 'ALTER TABLE files DROP CONSTRAINT IF EXISTS files_pkey',                  add: 'ALTER TABLE files ADD PRIMARY KEY (id)' },
  { table: 'files',         name: 'files_file_path_key', drop: 'ALTER TABLE files DROP CONSTRAINT IF EXISTS files_file_path_key',         add: 'ALTER TABLE files ADD CONSTRAINT files_file_path_key UNIQUE (file_path)' },
  { table: 'reporting',     name: 'reporting_pkey',      drop: 'ALTER TABLE reporting DROP CONSTRAINT IF EXISTS reporting_pkey',           add: 'ALTER TABLE reporting ADD PRIMARY KEY (call_id)' },
  { table: 'user_sessions', name: 'user_sessions_pkey',  drop: 'ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_pkey',  add: 'ALTER TABLE user_sessions ADD PRIMARY KEY (id)' },
  { table: 'audit_logs',    name: 'audit_logs_pkey',     drop: 'ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_pkey',        add: 'ALTER TABLE audit_logs ADD PRIMARY KEY (id)' },
];

// Secondary indexes (created after data load)
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_files_phone ON files(phone)',
  'CREATE INDEX IF NOT EXISTS idx_files_email ON files(email)',
  'CREATE INDEX IF NOT EXISTS idx_files_call_date ON files(call_date)',
  'CREATE INDEX IF NOT EXISTS idx_files_call_time ON files(call_time)',
  'CREATE INDEX IF NOT EXISTS idx_files_duration ON files(duration_ms)',
  'CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_files_composite ON files(call_date, phone, email)',
  'CREATE INDEX IF NOT EXISTS idx_files_call_id ON files(call_id)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_timestamp ON reporting(timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_timestamp_desc ON reporting(timestamp DESC)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_agent ON reporting(agent)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_agent_name ON reporting(agent_name)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_campaign ON reporting(campaign)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_call_type ON reporting(call_type)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_ani ON reporting(ani)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_dnis ON reporting(dnis)',
  'CREATE INDEX IF NOT EXISTS idx_reporting_customer_name ON reporting(customer_name)',
  'CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_user_sessions_login_time ON user_sessions(login_time)',
  'CREATE INDEX IF NOT EXISTS idx_user_sessions_user_email ON user_sessions(user_email)',
  'CREATE INDEX IF NOT EXISTS idx_user_sessions_last_activity ON user_sessions(last_activity)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(action_timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_user_email ON audit_logs(user_email)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_file_path ON audit_logs(file_path)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_composite ON audit_logs(user_id, action_type, action_timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_call_id ON audit_logs(call_id)',
];
const INDEX_NAMES = INDEXES.map(sql => sql.match(/INDEX IF NOT EXISTS (\S+)/)[1]);

// ── COPY-based table migration ──────────────────────────────
async function migrateTable(sqlite, pgClient, table, opts = {}) {
  if (!tableExists(sqlite, table)) {
    console.log(`  ⏭  "${table}" not in SQLite — skipping`);
    return 0;
  }

  const allCols = getColumns(sqlite, table);
  const skipSet = new Set(opts.skipColumns || []);
  const columns = allCols.filter(c => !skipSet.has(c));
  const total = countRows(sqlite, table);

  console.log(`  📋 "${table}" — ${fmt(total)} rows, ${columns.length} cols`);
  if (total === 0) return 0;

  const colList = columns.join(', ');

  // Prepare SQLite statement with rowid cursor.
  // WHERE rowid > ? ORDER BY rowid LIMIT ? is always O(batch),
  // unlike LIMIT ? OFFSET ? which is O(offset) — critical at 25M rows.
  const stmt = sqlite.prepare(
    `SELECT rowid AS __rid, ${colList} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`
  );

  // Stream state
  let lastRowId = 0;
  let migrated = 0;
  const t0 = Date.now();
  let lastLog = t0;

  // Readable stream that pulls from SQLite on-demand.
  // The COPY stream applies backpressure automatically — if PG can't
  // keep up, read() won't be called again until the pipe drains.
  const source = new Readable({
    read() {
      const rows = stmt.all(lastRowId, READ_BATCH);
      if (!rows.length) {
        this.push(null); // signal EOF
        return;
      }
      lastRowId = rows[rows.length - 1].__rid;
      migrated += rows.length;

      // Build COPY text block: col1\tcol2\t...\n per row
      // Using array.join() is faster than string concat in V8 for large strings
      const lines = new Array(rows.length);
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const vals = new Array(columns.length);
        for (let i = 0; i < columns.length; i++) {
          vals[i] = esc(row[columns[i]]);
        }
        lines[r] = vals.join('\t');
      }
      this.push(lines.join('\n') + '\n');

      // Progress every 2 seconds
      const now = Date.now();
      if (now - lastLog >= 2000) {
        const elapsed = (now - t0) / 1000;
        const rate = Math.round(migrated / elapsed);
        const pct = ((migrated / total) * 100).toFixed(1);
        const eta = rate > 0 ? dur(((total - migrated) / rate) * 1000) : '?';
        process.stdout.write(`\r     ${pct}% — ${fmt(migrated)}/${fmt(total)} — ${fmt(rate)} rows/sec — ETA ${eta}       `);
        lastLog = now;
      }
    }
  });

  // Pipe SQLite → COPY FROM STDIN (backpressure handled by pipeline)
  const copyStream = pgClient.query(
    copyFrom(`COPY ${table} (${colList}) FROM STDIN`)
  );
  await pipeline(source, copyStream);

  // Final line
  const totalMs = Date.now() - t0;
  const finalRate = totalMs > 0 ? Math.round(migrated / (totalMs / 1000)) : migrated;
  process.stdout.write(`\r     100% — ${fmt(migrated)}/${fmt(total)} — ${fmt(finalRate)} rows/sec                         \n`);
  console.log(`  ✅ "${table}" — ${fmt(migrated)} rows in ${dur(totalMs)} (${fmt(finalRate)} rows/sec)`);
  return migrated;
}

// ── Create PG tables (schema only, constraints added after load) ──
async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      phone TEXT, email TEXT, call_date TEXT, call_time TEXT, call_id TEXT,
      duration_ms INTEGER, file_size INTEGER,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS reporting (
      call_id TEXT PRIMARY KEY,
      timestamp TEXT, campaign TEXT, call_type TEXT, agent TEXT, agent_name TEXT,
      disposition TEXT, ani TEXT, customer_name TEXT, dnis TEXT,
      call_time INTEGER, bill_time_rounded INTEGER, cost DOUBLE PRECISION,
      ivr_time INTEGER, queue_wait_time INTEGER, ring_time INTEGER,
      talk_time INTEGER, hold_time INTEGER, park_time INTEGER,
      after_call_work_time INTEGER, transfers INTEGER, conferences INTEGER,
      holds INTEGER, abandoned INTEGER, recordings TEXT, raw_json TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL, user_email TEXT NOT NULL,
      login_time TIMESTAMP DEFAULT NOW(), logout_time TIMESTAMP,
      session_duration_ms INTEGER, ip_address TEXT, user_agent TEXT,
      last_activity TIMESTAMP
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL, user_email TEXT NOT NULL, action_type TEXT NOT NULL,
      file_path TEXT, file_phone TEXT, file_email TEXT, call_id TEXT,
      action_timestamp TIMESTAMP DEFAULT NOW(),
      ip_address TEXT, user_agent TEXT, session_id TEXT, additional_data TEXT
    )`);
}

async function fixSequence(client, table, column) {
  try {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${table}', '${column}'), COALESCE((SELECT MAX(${column}) FROM ${table}), 0) + 1, false)`
    );
  } catch (e) {
    console.warn(`  ⚠️  Sequence reset failed for ${table}.${column}: ${e.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────
const TABLES = ['files', 'reporting', 'user_sessions', 'audit_logs'];

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  SQLite → PostgreSQL Migration (COPY Protocol)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  SQLite : ${path.resolve(SQLITE_PATH)}`);
  console.log(`  PG     : ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'recbot'}`);
  console.log(`  Batch  : ${fmt(READ_BATCH)} rows per SQLite read`);
  console.log('');

  // Open SQLite (read-only)
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  console.log('📖 SQLite opened (read-only)');

  let grandTotal = 0;
  for (const t of TABLES) {
    if (tableExists(sqlite, t)) {
      const cnt = countRows(sqlite, t);
      grandTotal += cnt;
      console.log(`   ${t}: ${fmt(cnt)} rows`);
    }
  }
  console.log(`   Total: ${fmt(grandTotal)} rows\n`);

  const pgClient = await pool.connect();
  console.log('🐘 PostgreSQL connected\n');
  const migrationStart = Date.now();

  try {
    // 1. Ensure tables exist
    console.log('📐 Ensuring tables exist...');
    await ensureTables(pgClient);
    console.log('   Done.\n');

    // 2. Drop secondary indexes (avoid per-row index maintenance during load)
    console.log('🗑️  Dropping indexes...');
    for (const name of INDEX_NAMES) {
      try { await pgClient.query(`DROP INDEX IF EXISTS ${name}`); } catch {}
    }
    console.log(`   ${INDEX_NAMES.length} indexes dropped.\n`);

    // 3. Drop constraints (PK, UNIQUE) — critical for COPY speed
    console.log('🗑️  Dropping constraints...');
    for (const c of CONSTRAINTS) {
      try { await pgClient.query(c.drop); } catch {}
    }
    console.log(`   ${CONSTRAINTS.length} constraints dropped.\n`);

    // 4. Truncate tables (clean load — COPY can't do ON CONFLICT)
    console.log('🧹 Truncating tables...');
    for (const t of TABLES) {
      await pgClient.query(`TRUNCATE ${t} RESTART IDENTITY`);
    }
    console.log('   Done.\n');

    // 5. Tune PG session for bulk loading
    console.log('⚡ Tuning PostgreSQL for bulk load...');
    await pgClient.query(`SET synchronous_commit = off`);
    await pgClient.query(`SET work_mem = '256MB'`);
    await pgClient.query(`SET maintenance_work_mem = '512MB'`);
    try { await pgClient.query(`SET max_wal_size = '2GB'`); } catch {}
    console.log('   synchronous_commit=off, work_mem=256MB, maintenance_work_mem=512MB\n');

    // 6. COPY each table
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Loading data via COPY FROM STDIN');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await migrateTable(sqlite, pgClient, 'files', { skipColumns: ['id'] });
    console.log('');
    await migrateTable(sqlite, pgClient, 'reporting');
    console.log('');
    await migrateTable(sqlite, pgClient, 'user_sessions', { skipColumns: ['id'] });
    console.log('');
    await migrateTable(sqlite, pgClient, 'audit_logs', { skipColumns: ['id'] });
    console.log('');

    // 7. Recreate constraints
    console.log('━━━ Recreating Constraints ━━━');
    const cStart = Date.now();
    for (const c of CONSTRAINTS) {
      try {
        await pgClient.query(c.add);
        console.log(`  ✅ ${c.name}`);
      } catch (e) {
        console.warn(`  ❌ ${c.name}: ${e.message}`);
      }
    }
    console.log(`  Done in ${dur(Date.now() - cStart)}\n`);

    // 8. Fix SERIAL sequences
    console.log('🔧 Fixing sequences...');
    await fixSequence(pgClient, 'files', 'id');
    await fixSequence(pgClient, 'user_sessions', 'id');
    await fixSequence(pgClient, 'audit_logs', 'id');
    console.log('');

    // 9. Rebuild secondary indexes
    console.log('━━━ Rebuilding Indexes ━━━');
    const idxStart = Date.now();
    for (let i = 0; i < INDEXES.length; i++) {
      try {
        await pgClient.query(INDEXES[i]);
        process.stdout.write(`\r  ${i + 1}/${INDEXES.length} indexes created`);
      } catch (e) {
        console.warn(`\n  ⚠️  ${INDEX_NAMES[i]}: ${e.message}`);
      }
    }
    console.log(`\n  ✅ Indexes rebuilt in ${dur(Date.now() - idxStart)}\n`);

    // 10. Re-enable normal commit mode
    await pgClient.query(`SET synchronous_commit = on`);

    // 11. ANALYZE for query planner
    console.log('📊 Running ANALYZE...');
    for (const t of TABLES) await pgClient.query(`ANALYZE ${t}`);
    console.log('   Done.\n');

    // 12. Verify counts
    console.log('━━━ Verification ━━━');
    for (const t of TABLES) {
      const sc = tableExists(sqlite, t) ? countRows(sqlite, t) : 'N/A';
      const pc = (await pgClient.query(`SELECT COUNT(*) as c FROM ${t}`)).rows[0].c;
      const ok = String(sc) === String(pc) ? '✅' : '⚠️';
      console.log(`  ${ok} ${t}: SQLite=${fmt(Number(sc))} → PG=${fmt(Number(pc))}`);
    }

    const elapsed = Date.now() - migrationStart;
    const rate = elapsed > 0 ? Math.round(grandTotal / (elapsed / 1000)) : grandTotal;
    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`  ✅ Migration complete!`);
    console.log(`     ${fmt(grandTotal)} rows in ${dur(elapsed)} (${fmt(rate)} rows/sec)`);
    console.log(`═══════════════════════════════════════════════════`);

  } finally {
    pgClient.release();
    sqlite.close();
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});
