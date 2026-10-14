#!/usr/bin/env node
// ============================================================
// Phone-lookup index build for the `reporting` table
// ============================================================
//
// Phone searches (`/api/reports?phone=...`) previously seq-scanned the
// whole table because `ani LIKE '%input%'` cannot use a b-tree. This
// script builds the indexes that make those searches indexable:
//
//   • last10 expression indexes — normalized digits, exact equality.
//     Used when the search input has 7+ digits. Expression indexes do
//     NOT rewrite the table, so there is no ACCESS EXCLUSIVE lock.
//   • pg_trgm GIN indexes — substring search, used for shorter inputs.
//   • (lower(agent), call_id) — backs the Recordings page's "Only my
//     calls" filter, which matches agents case-insensitively.
//
// It also drops idx_reporting_timestamp_desc: a b-tree scans backward
// natively, so the DESC duplicate only cost write throughput on ingest.
//
// Every statement uses CONCURRENTLY and therefore cannot run inside a
// transaction block — each one is issued on its own, in autocommit.
// Reads and writes continue normally while these build.
//
// Usage:
//   node scripts/optimize-reporting-indexes.mjs
//   node scripts/optimize-reporting-indexes.mjs --dry-run
//
// Safe to re-run: every statement is IF NOT EXISTS / IF EXISTS. A build
// interrupted partway leaves an INVALID index behind — re-running does
// not retry it, so drop the invalid one by hand first (the script
// reports any it finds on startup).
// ============================================================

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

const { Client } = pg;

// These must stay in lockstep with phoneLast10Expr() in backend/database.js.
// Postgres matches an expression index by the parsed expression tree, so
// whitespace is irrelevant but the functions, arguments and their order are
// not: swapping '[^0-9]' for '\D', or dropping the coalesce, yields a
// different expression, silently disables the index, and brings the seq
// scans back. Kept character-identical here so the pairing is obvious.
const ANI_LAST10 = `right(regexp_replace(coalesce(ani, ''), '[^0-9]', '', 'g'), 10)`;
const DNIS_LAST10 = `right(regexp_replace(coalesce(dnis, ''), '[^0-9]', '', 'g'), 10)`;

const STATEMENTS = [
  {
    label: 'pg_trgm extension',
    sql: `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  },
  {
    label: 'idx_reporting_ani_last10',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reporting_ani_last10
            ON reporting (${ANI_LAST10})`,
  },
  {
    label: 'idx_reporting_dnis_last10',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reporting_dnis_last10
            ON reporting (${DNIS_LAST10})`,
  },
  {
    label: 'idx_reporting_ani_trgm',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reporting_ani_trgm
            ON reporting USING gin (ani gin_trgm_ops)`,
  },
  {
    label: 'idx_reporting_dnis_trgm',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reporting_dnis_trgm
            ON reporting USING gin (dnis gin_trgm_ops)`,
  },
  {
    // Must match ownedBySql() in backend/database.js (lower(r.agent) = email);
    // without it, "Only my calls" over a long date range scans all of reporting.
    label: 'idx_reporting_agent_lower_call_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reporting_agent_lower_call_id
            ON reporting (lower(agent), call_id)`,
  },
  {
    label: 'drop redundant idx_reporting_timestamp_desc',
    sql: `DROP INDEX CONCURRENTLY IF EXISTS idx_reporting_timestamp_desc`,
  },
  {
    label: 'ANALYZE reporting',
    sql: `ANALYZE reporting`,
  },
];

function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

async function reportInvalidIndexes(client) {
  const { rows } = await client.query(`
    SELECT c.relname
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'reporting' AND NOT i.indisvalid
  `);
  if (!rows.length) return;
  console.log('⚠️  Invalid indexes found on `reporting` (left by an interrupted');
  console.log('    CONCURRENTLY build). CREATE ... IF NOT EXISTS will skip these,');
  console.log('    so drop each one before re-running:');
  for (const r of rows) {
    console.log(`      DROP INDEX CONCURRENTLY ${r.relname};`);
  }
  console.log('');
}

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'recbot',
    user: process.env.DB_USER || 'recbot',
    password: process.env.DB_PASSWORD || 'recbot',
  });

  await client.connect();

  console.log('═══════════════════════════════════════════════════');
  console.log('  Reporting phone-lookup index build');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  PG     : ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'recbot'}`);
  if (DRY_RUN) console.log('  Mode   : DRY RUN (nothing will be executed)');
  console.log('');

  try {
    // An index build on a large table can run for a long time; make sure a
    // server-side statement_timeout doesn't kill it partway through.
    if (!DRY_RUN) await client.query(`SET statement_timeout = 0`);

    const { rows: [size] } = await client.query(`
      SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'reporting'
    `);
    if (size) {
      console.log(`  Estimated rows: ${Number(size.estimate).toLocaleString('en-US')}`);
      console.log('');
    }

    await reportInvalidIndexes(client);

    const started = Date.now();
    for (const { label, sql } of STATEMENTS) {
      if (DRY_RUN) {
        console.log(`→ ${label}\n${sql}\n`);
        continue;
      }
      process.stdout.write(`→ ${label} ... `);
      const t0 = Date.now();
      await client.query(sql);
      console.log(`done in ${fmtDuration(Date.now() - t0)}`);
    }

    if (!DRY_RUN) {
      console.log('');
      console.log(`✅ Completed in ${fmtDuration(Date.now() - started)}`);
      console.log('');
      console.log('   Verify the planner picks them up:');
      console.log('     EXPLAIN (ANALYZE, BUFFERS) SELECT call_id FROM reporting');
      console.log(`     WHERE ${ANI_LAST10} = '5551234567';`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('');
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
