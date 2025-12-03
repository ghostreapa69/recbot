import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import crypto from 'crypto';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import utcPlugin from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from '@smithy/node-http-handler';
import http from 'http';
import https from 'https';
import { queryFiles, indexFiles, indexFile, getDatabaseStats, getAuditLogs, getUserSessions, logAuditEvent, parseFileMetadata, logUserLogout, logUserSession, getDistinctUsers, expireStaleSessions, touchUserSession, expireInactiveSessions, repairOpenSessions, backfillExpiredOpenSessions, backfillFileMetadata, backfillAuditLogCallIds, queryReports, exportReports, getReportingSummary, getDistinctCampaigns, getDistinctCallTypes, exportAuditLogs, getUserUsageReport, exportUserUsageReport, normalizeReportTimestamp, getLegacyReportTimestampStats, rewriteReportTimestamps, getCallIdsWithRecordings } from './database.js';
import { fetchLastHourCallLog, scheduleRecurringIngestion } from './five9.js';
import { clerkAuth, requireAuth, requireAdmin, requireMemberOrAdmin, requireAuthenticatedUser, requireManagerOrAdmin, allowedLoginConfig } from './auth.js';

dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);
dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

const app = express();
const PORT = process.env.PORT || 4000;
const BUILD_DIR = path.join(process.cwd(), '../frontend/build');
const WAV_DIR = '/data/wav/recordings'; // For reference, not used with S3

const REPORT_FILTER_FALLBACK_TIMEZONE = process.env.REPORTS_QUERY_TIMEZONE || process.env.FIVE9_TIMEZONE || 'UTC';

app.use(cors());
app.use(express.json()); // Parse JSON request bodies

// Configure Express to trust proxies for proper IP extraction
app.set('trust proxy', true);

// Middleware to extract real client IP from proxy headers
app.use((req, res, next) => {
  // Capture raw headers for diagnostics (not stored, just logged when needed)
  const h = req.headers;

  // Canonical header names we care about
  const cf = h['cf-connecting-ip'];
  const xReal = h['x-real-ip'];
  const xForwardedFor = h['x-forwarded-for'];
  const xClient = h['x-client-ip'];

  // Build candidate list in priority order: Cloudflare > X-Real-IP (Traefik) > first X-Forwarded-For > x-client-ip > req.ip
  let candidate = cf || xReal || (xForwardedFor ? xForwardedFor.split(',')[0].trim() : null) || xClient || req.ip || 'unknown';

  // Strip IPv6 previx if Node expressed it
  if (candidate && candidate.startsWith('::ffff:')) candidate = candidate.slice(7);

  req.realClientIP = candidate;
  req.forwardedChain = xForwardedFor || null; // keep chain for potential later auditing

  // Only verbose-log once per request path for now
  console.log('🌐 [IP] resolved=%s cf=%s x-real=%s x-forwarded-for=%s node-ip=%s', candidate, cf || '-', xReal || '-', xForwardedFor || '-', req.ip);
  next();
});

app.use(clerkAuth); // Add Clerk authentication middleware

// Fallback session creator: ensures every authenticated user has an active session row
app.use(async (req, res, next) => {
  // Only proceed for routes using requireAuth (those will set req.user) – if not set yet just continue
  if (!req.path.startsWith('/api/') || req.path === '/api/config') return next();
  // If user object not yet populated, continue; requireAuth will populate in route chain
  // We'll run another tiny middleware after requireAuth inside protected routes if needed.
  return next();
});

// Tunable S3 HTTP configuration to avoid socket exhaustion under heavy parallel audio/waveform requests
const S3_MAX_SOCKETS = parseInt(process.env.S3_MAX_SOCKETS || '200', 10); // default 50 -> raise
const S3_SOCKET_TIMEOUT_MS = parseInt(process.env.S3_SOCKET_TIMEOUT_MS || '60000', 10);
const S3_CONNECTION_TIMEOUT_MS = parseInt(process.env.S3_CONNECTION_TIMEOUT_MS || '10000', 10);
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
    socketTimeout: S3_SOCKET_TIMEOUT_MS,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: S3_MAX_SOCKETS }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: S3_MAX_SOCKETS })
  })
});
console.log(`[S3] Client initialized region=${process.env.AWS_REGION} maxSockets=${S3_MAX_SOCKETS} socketTimeoutMs=${S3_SOCKET_TIMEOUT_MS}`);
const S3_FAILURE_UNHEALTHY_WINDOW_MS = parseInt(process.env.S3_FAILURE_UNHEALTHY_WINDOW_MS || '0', 10);
const EXIT_ON_S3_FAILURE = /^true$/i.test(process.env.EXIT_ON_S3_FAILURE || '');
let lastS3FetchFailureAt = null;
let lastS3FetchFailureMessage = null;
let lastS3FetchSuccessAt = Date.now();
let s3FailureExitScheduled = false;

function recordS3Failure(message) {
  lastS3FetchFailureAt = Date.now();
  lastS3FetchFailureMessage = message;

  if (EXIT_ON_S3_FAILURE && !s3FailureExitScheduled) {
    s3FailureExitScheduled = true;
    setTimeout(() => {
      console.error('🔁 [HEALTH] EXIT_ON_S3_FAILURE enabled; terminating process for container restart');
      process.exit(70);
    }, 500);
  }
}

function recordS3Success() {
  lastS3FetchSuccessAt = Date.now();
  s3FailureExitScheduled = false;
}

app.get('/healthz', (req, res) => {
  const now = Date.now();
  const failureActive = lastS3FetchFailureAt && (!lastS3FetchSuccessAt || lastS3FetchSuccessAt < lastS3FetchFailureAt);
  const failureAge = failureActive ? (now - lastS3FetchFailureAt) : null;
  const degradeIndefinitely = S3_FAILURE_UNHEALTHY_WINDOW_MS <= 0;
  const withinWindow = failureActive && (degradeIndefinitely || (failureAge !== null && failureAge <= S3_FAILURE_UNHEALTHY_WINDOW_MS));

  if (failureActive && withinWindow) {
    return res.status(503).json({
      status: 'error',
      reason: 'recent_s3_failure',
      lastFailureAt: new Date(lastS3FetchFailureAt).toISOString(),
      lastFailureMessage: lastS3FetchFailureMessage,
      lastSuccessAt: lastS3FetchSuccessAt ? new Date(lastS3FetchSuccessAt).toISOString() : null,
      failureAgeMs: failureAge
    });
  }

  return res.json({
    status: 'ok',
    lastFailureAt: lastS3FetchFailureAt ? new Date(lastS3FetchFailureAt).toISOString() : null,
    lastSuccessAt: lastS3FetchSuccessAt ? new Date(lastS3FetchSuccessAt).toISOString() : null,
    failureAgeMs: failureAge
  });
});

// Lightweight HEAD cache to reduce duplicate S3 HeadObject traffic (TTL 60s)
const headCacheTTL = parseInt(process.env.S3_HEAD_CACHE_TTL_MS || '60000', 10);
const headCache = new Map(); // key -> { ts, exists }
function headCacheGet(key){
  const v = headCache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > headCacheTTL){ headCache.delete(key); return null; }
  return v.exists;
}
function headCacheSet(key, exists){ headCache.set(key, { ts: Date.now(), exists }); }

// Concurrency limiter for audio S3 operations (avoid enqueuing hundreds exceeding socket capacity)
const AUDIO_S3_MAX_CONCURRENT = parseInt(process.env.AUDIO_S3_MAX_CONCURRENT || '30', 10);
let audioS3Active = 0; const audioS3Queue = [];
function acquireAudioS3(){
  return new Promise(resolve => {
    const tryStart = () => {
      if (audioS3Active < AUDIO_S3_MAX_CONCURRENT){ audioS3Active++; resolve(); return true; }
      return false;
    };
    if (!tryStart()) audioS3Queue.push(tryStart);
  });
}
function releaseAudioS3(){
  audioS3Active = Math.max(0, audioS3Active - 1);
  while (audioS3Queue.length && audioS3Active < AUDIO_S3_MAX_CONCURRENT){
    const starter = audioS3Queue.shift();
    if (starter) starter();
  }
}
setInterval(()=>{
  if (audioS3Active) console.log(`[AUDIO S3] active=${audioS3Active} queued=${audioS3Queue.length}`);
}, 15000);

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.length === 0) return '';
  const needsQuotes = /[",\n\r]/.test(str);
  const escaped = str.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function buildCsv(rows, columns) {
  const headerLine = columns.map(col => escapeCsvValue(col.header)).join(',');
  const dataLines = rows.map(row => columns.map(col => {
    if (typeof col.accessor === 'function') {
      return escapeCsvValue(col.accessor(row));
    }
    return escapeCsvValue(row[col.key]);
  }).join(','));
  return [headerLine, ...dataLines].join('\r\n');
}

function normalizeFilterToUtc(value, preferredTz = REPORT_FILTER_FALLBACK_TIMEZONE) {
  if (!value) return null;
  const trimmed = typeof value === 'string' ? value.trim() : String(value).trim();
  if (!trimmed) return null;

  const hasOffset = /Z$/i.test(trimmed) || /([+-]\d{2}:?\d{2})$/.test(trimmed);
  if (hasOffset) {
    const direct = dayjs(trimmed);
    if (direct.isValid()) return direct.utc().toISOString();
  }

  try {
    const zoned = dayjs.tz(trimmed, preferredTz);
    if (zoned.isValid()) return zoned.utc().toISOString();
  } catch {
    // ignore tz parsing errors, fall through to generic parsing
  }

  const generic = dayjs(trimmed);
  if (generic.isValid()) return generic.utc().toISOString();

  return null;
}

function parseDurationMsFlexible(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  }
  const str = String(value).trim();
  if (!str) return null;
  if (/ms$/i.test(str)) {
    const numeric = Number(str.replace(/ms$/i, '').trim());
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(str)) {
    const seconds = Number(str);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
  }
  if (str.includes(':')) {
    const parts = str.split(':');
    if (parts.length === 3) {
      const [hhRaw, mmRaw, ssRaw] = parts;
      const hours = Number(hhRaw);
      const minutes = Number(mmRaw);
      const seconds = Number(ssRaw);
      if ([hours, minutes, seconds].some(n => Number.isNaN(n))) return null;
      const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
      return Math.max(0, Math.round(totalSeconds * 1000));
    }
  }
  return null;
}

function parseIntegerFlexible(value) {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value.trim() : String(value).trim();
  if (!str) return null;
  const num = Number(str);
  return Number.isFinite(num) ? Math.round(num) : null;
}

const REPORT_DURATION_FIELD_MAP = {
  call_time: ['CALL_TIME', 'CALLTIME'],
  bill_time_rounded: ['BILL_TIME_(ROUNDED)', 'BILL_TIME_ROUNDED'],
  ivr_time: ['IVR_TIME'],
  queue_wait_time: ['QUEUE_WAIT_TIME'],
  ring_time: ['RING_TIME'],
  talk_time: ['TALK_TIME'],
  hold_time: ['HOLD_TIME'],
  park_time: ['PARK_TIME'],
  after_call_work_time: ['AFTER_CALL_WORK_TIME']
};

const REPORT_COST_KEYS = ['COST'];

const REPORT_INTEGER_FIELD_MAP = {
  transfers: ['TRANSFERS'],
  conferences: ['CONFERENCES'],
  holds: ['HOLDS'],
  abandoned: ['ABANDONED']
};

function hydrateReportRow(row) {
  if (!row) return row;
  let rawPayload = row.raw_json_parsed && typeof row.raw_json_parsed === 'object' ? row.raw_json_parsed : null;
  if (!rawPayload && typeof row.raw_json === 'string') {
    try {
      rawPayload = JSON.parse(row.raw_json);
    } catch {
      rawPayload = null;
    }
  }
  if (!rawPayload) return row;

  const hydrated = { ...row };

  for (const [field, rawKeys] of Object.entries(REPORT_DURATION_FIELD_MAP)) {
    const current = Number(hydrated[field]);
    const needsHydration = !Number.isFinite(current) || current < 0 || current === 0;
    if (!needsHydration) continue;
    const rawValue = rawKeys.map(k => rawPayload[k]).find(v => v !== undefined && v !== null && v !== '');
    const parsed = parseDurationMsFlexible(rawValue);
    if (parsed !== null && parsed > 0) {
      hydrated[field] = parsed;
    }
  }

  // Cost may need precision but already stored as float. Refresh if zero but raw has value.
  if (Number(hydrated.cost) === 0 || !Number.isFinite(Number(hydrated.cost))) {
    const rawCost = REPORT_COST_KEYS.map(k => rawPayload[k]).find(v => v !== undefined && v !== null && v !== '');
    if (rawCost !== undefined) {
      const parsedCost = Number(rawCost);
      if (Number.isFinite(parsedCost)) hydrated.cost = parsedCost;
    }
  }

  for (const [field, rawKeys] of Object.entries(REPORT_INTEGER_FIELD_MAP)) {
    const current = Number(hydrated[field]);
    const rawValue = rawKeys.map(k => rawPayload[k]).find(v => v !== undefined && v !== null && v !== '');
    const parsed = parseIntegerFlexible(rawValue);
    if (parsed === null) continue;
    if (!Number.isFinite(current) || (current === 0 && parsed > 0)) {
      hydrated[field] = parsed;
    }
  }

  return hydrated;
}

function hydrateReportRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const hydrated = rows.map(hydrateReportRow);

  try {
    const callIds = Array.from(new Set(hydrated.map(row => (row && row.call_id ? String(row.call_id) : null)).filter(Boolean)));
    if (callIds.length) {
      const availabilityMap = getCallIdsWithRecordings(callIds);
      if (availabilityMap && typeof availabilityMap === 'object') {
        for (const row of hydrated) {
          if (!row || !row.call_id) continue;
          if (availabilityMap[row.call_id]) {
            row.hasRecording = true;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[REPORT] Failed to hydrate recording availability:', err.message);
  }

  return hydrated;
}

// ----------------------------------------------
// FFmpeg concurrency + configuration
// ----------------------------------------------
const FFMPEG_MAX_CONCURRENCY = parseInt(process.env.FFMPEG_MAX_CONCURRENCY || '2');
const FFMPEG_OUTPUT_HZ = process.env.FFMPEG_OUTPUT_HZ || '16000'; // lower for smaller payloads
let ffmpegActive = 0;
const ffmpegQueue = [];
function acquireFfmpegSlot() {
  return new Promise(resolve => {
    const tryStart = () => {
      if (ffmpegActive < FFMPEG_MAX_CONCURRENCY) {
        ffmpegActive++;
        resolve();
        return true;
      }
      return false;
    };
    if (!tryStart()) ffmpegQueue.push(tryStart);
  });
}
function releaseFfmpegSlot() {
  ffmpegActive = Math.max(0, ffmpegActive - 1);
  while (ffmpegQueue.length && ffmpegActive < FFMPEG_MAX_CONCURRENCY) {
    const starter = ffmpegQueue.shift();
    if (starter) starter();
  }
}

// --- AUTO SESSION EXPIRATION (4h) ---
const MAX_SESSION_HOURS = parseInt(process.env.MAX_SESSION_HOURS || '4');
const MAX_INACTIVITY_MINUTES = parseInt(process.env.MAX_INACTIVITY_MINUTES || '30');
// Run every 5 minutes to catch stale sessions
setInterval(() => {
  try {
    const expired = expireStaleSessions(MAX_SESSION_HOURS, 200);
    if (Array.isArray(expired) && expired.length) {
      console.log(`⏰ [SESSION EXPIRY] Auto-logged out ${expired.length} session(s) > ${MAX_SESSION_HOURS}h`);
      for (const row of expired) {
        // Audit each auto logout
        logAuditEvent(
          row.user_id,
          row.user_email,
          'LOGOUT',
          null,
          null,
          row.ip_address || null,
          row.user_agent || null,
          row.id,
          { reason: 'auto_expire_interval', maxHours: MAX_SESSION_HOURS, login_time: row.login_time }
        );
      }
    }
    const inactive = expireInactiveSessions(MAX_INACTIVITY_MINUTES, 300);
    if (Array.isArray(inactive) && inactive.length) {
      console.log(`💤 [INACTIVITY EXPIRY] Auto-logged out ${inactive.length} inactive session(s) > ${MAX_INACTIVITY_MINUTES}m`);
      for (const row of inactive) {
        logAuditEvent(
          row.user_id,
          row.user_email,
          'LOGOUT',
          null,
          null,
          row.ip_address || null,
          row.user_agent || null,
          row.id,
          { reason: 'auto_inactive', minutes: MAX_INACTIVITY_MINUTES, last_activity: row.last_activity, login_time: row.login_time }
        );
      }
    }
  } catch (e) {
    console.error('Auto session expiry error:', e);
  }
}, 5 * 60 * 1000);

// Kick off Five9 ingestion scheduler (interval configurable via env)
scheduleRecurringIngestion();

// Endpoint to manually trigger report ingestion for the configured window (admin only)
app.post('/api/reports/ingest', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const result = await fetchLastHourCallLog({ auditUser: req.user });
      const responsePayload = {
        success: true,
        ...result
      };
      res.json(responsePayload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint to convert legacy report timestamps to canonical UTC ISO format
app.post('/api/reports/fix-timezones', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const batchSize = parseInt(req.body?.batchSize || '5000', 10);
    const runAll = req.body?.runAll !== false;
    const includeIso = req.body?.includeIso === true;
    const dryRun = req.body?.dryRun === true;

    console.log(`[TIMESTAMP FIX] Starting rewrite batchSize=${batchSize} runAll=${runAll} includeIso=${includeIso} dryRun=${dryRun}`);
    const result = rewriteReportTimestamps({ batchSize, runAll, includeIso, dryRun });
    const legacy = getLegacyReportTimestampStats(10);

    console.log(`[TIMESTAMP FIX] Complete: processed=${result.processed} updated=${result.updated} errors=${result.errors} batches=${result.batches} remaining=${result.remainingLegacy}`);
    if (result.sampleConversions?.length) {
      result.sampleConversions.forEach((sample, idx) => {
        console.log(`   [TIMESTAMP FIX] Sample ${idx + 1}: "${sample.from}" -> "${sample.to}" (call_id=${sample.callId})`);
      });
    }

    res.json({
      success: true,
      ...result,
      legacyStats: legacy
    });
  } catch (e) {
    console.error('[TIMESTAMP FIX] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Query reports with filters
app.get('/api/reports', requireAuth, ensureSession, async (req, res) => {
  try {
    let { start, end, agent, agentName, agentSearchType, campaign, callType, phone, callId, customerName, afterCallWork, transfers, conferences, abandoned, limit = 100, offset = 0, timezone: userTimezone, sort } = req.query;
    
    // Clean up "undefined" strings
    const cleanParam = (val) => (!val || val === 'undefined' || val === 'null') ? null : val;
    start = cleanParam(start);
    end = cleanParam(end);
    agent = cleanParam(agent);
    agentName = cleanParam(agentName);
    agentSearchType = cleanParam(agentSearchType);
    campaign = cleanParam(campaign);
    callType = cleanParam(callType);
    phone = cleanParam(phone);
    callId = cleanParam(callId);
    customerName = cleanParam(customerName);
    afterCallWork = cleanParam(afterCallWork);
    transfers = cleanParam(transfers);
    conferences = cleanParam(conferences);
    abandoned = cleanParam(abandoned);

    if (typeof phone === 'string') phone = phone.trim();
    if (typeof callId === 'string') callId = callId.trim();
    if (typeof customerName === 'string') customerName = customerName.trim();
    if (typeof afterCallWork === 'string') afterCallWork = afterCallWork.trim();
    if (typeof agentName === 'string') agentName = agentName.trim();
    if (typeof agentSearchType === 'string') agentSearchType = agentSearchType.trim().toLowerCase();
    if (typeof transfers === 'string') transfers = transfers.trim();
    if (typeof conferences === 'string') conferences = conferences.trim();
    if (typeof abandoned === 'string') abandoned = abandoned.trim();
    if (phone === '') phone = null;
    if (callId === '') callId = null;
    if (customerName === '') customerName = null;
    if (afterCallWork === '') afterCallWork = null;
    if (agentName === '') agentName = null;
    if (agentSearchType === '') agentSearchType = null;
    if (transfers === '') transfers = null;
    if (conferences === '') conferences = null;
    if (abandoned === '') abandoned = null;
    
    if (!agentName && agent && agentSearchType === 'name') {
      agentName = agent;
      agent = null;
    } else if (!agent && agentName && agentSearchType === 'email') {
      agent = agentName;
      agentName = null;
    } else if (agent && !agentName && !agentSearchType && !/@/.test(agent)) {
      agentName = agent;
      agent = null;
    }

    console.log(`[API /api/reports] Query params: start="${start}", end="${end}", userTz="${userTimezone}", agent="${agent}", agentName="${agentName}", agentSearchType="${agentSearchType}", campaign="${campaign}", callType="${callType}", phone="${phone}", callId="${callId}", customerName="${customerName}", afterCallWork="${afterCallWork}", transfers="${transfers}", conferences="${conferences}", abandoned="${abandoned}", limit=${limit}, offset=${offset}`);
    
    const startFormatted = normalizeReportTimestamp(start);
    const endFormatted = normalizeReportTimestamp(end);
    
    if (startFormatted || endFormatted) {
      console.log(`[API /api/reports] Formatted for SQLite: start="${startFormatted}", end="${endFormatted}"`);
    }
    
    // Debug: check what's actually in the database
    try {
      const { db } = await import('./database.js');
      const dbSample = db.prepare('SELECT timestamp FROM reporting ORDER BY rowid DESC LIMIT 3').all();
      console.log('[API /api/reports] Recent timestamps in DB:', dbSample.map(r => r.timestamp));
      
      // Test if datetime parsing works
      if (startFormatted) {
        const testParse = db.prepare(`SELECT datetime(?) as parsed`).get(startFormatted);
        console.log('[API /api/reports] Datetime parse test:', startFormatted, '->', testParse.parsed);
      }
    } catch (debugErr) {
      console.warn('[API /api/reports] Debug query failed:', debugErr.message);
    }
    
    const appliedStart = startFormatted || null;
    const appliedEnd = endFormatted || null;
    const appliedLimit = Math.min(parseInt(limit,10)||100,500);
    const appliedOffset = parseInt(offset,10)||0;

    const parseInteger = (value) => {
      if (value === null || value === undefined) return null;
      const num = Number.parseInt(value, 10);
      return Number.isNaN(num) ? null : num;
    };
    const parseBinary = (value) => {
      const num = parseInteger(value);
      return (num === 0 || num === 1) ? num : null;
    };

    const afterCallWorkValue = parseInteger(afterCallWork);
    const transfersValue = parseBinary(transfers);
    const conferencesValue = parseBinary(conferences);
    const abandonedValue = parseBinary(abandoned);

    const sortDir = sort === 'asc' ? 'asc' : 'desc';
    const result = queryReports({
      start: appliedStart,
      end: appliedEnd,
      agent,
      agentName,
      campaign,
      callType,
      phone,
      callId,
      customerName,
      afterCallWork: afterCallWorkValue,
      transfers: transfersValue,
      conferences: conferencesValue,
      abandoned: abandonedValue,
      limit: appliedLimit,
      offset: appliedOffset,
      sort: sortDir
    });
      const hydratedRows = hydrateReportRows(result.rows);
      const returnedRange = hydratedRows && hydratedRows.length ? (
        sortDir === 'asc'
          ? { min: hydratedRows[0].timestamp || null, max: hydratedRows[hydratedRows.length - 1].timestamp || null }
          : { max: hydratedRows[0].timestamp || null, min: hydratedRows[hydratedRows.length - 1].timestamp || null }
      ) : { max: null, min: null };
    console.log(`[API /api/reports] Applied range: start="${appliedStart}" end="${appliedEnd}" limit=${appliedLimit} offset=${appliedOffset} sort=${sortDir}`);
    console.log(`[API /api/reports] Returned range: min="${returnedRange.min}" max="${returnedRange.max}" total=${result.total}`);

    let legacyStats = null;
    if (/^true$/i.test(process.env.REPORT_TIME_DEBUG || '')) {
      legacyStats = getLegacyReportTimestampStats(5);
      console.log(`[API /api/reports] Legacy timestamp rows remaining=${legacyStats.total}`);
      if (legacyStats.total && legacyStats.samples?.length) {
        legacyStats.samples.forEach((sample, idx) => {
          console.log(`   [legacy ${idx + 1}] call_id=${sample.call_id} timestamp="${sample.timestamp}"`);
        });
      }
    }
    try {
      logAuditEvent(
        req.user.id,
        req.user.email,
        'REPORT_VIEW',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          filters: {
            start: start || null,
            end: end || null,
            agent: agent || null,
            agentName: agentName || null,
            agentSearchType: agentSearchType || null,
            campaign: campaign || null,
            callType: callType || null,
            phone: phone || null
          },
          pagination: { limit: appliedLimit, offset: appliedOffset, sort: sortDir },
                    returned: hydratedRows ? hydratedRows.length : 0,
          total: result.total || 0,
          appliedRange: { start: appliedStart, end: appliedEnd },
          returnedRange,
          legacyTotal: legacyStats ? legacyStats.total : undefined
        }
      );
    } catch (e) {
      console.warn('REPORT_VIEW audit log failed:', e.message);
    }
      const responsePayload = {
        success: true,
        ...result,
        rows: hydratedRows,
        sort: sortDir,
        appliedRange: { start: appliedStart, end: appliedEnd },
        returnedRange
      };
    if (legacyStats) responsePayload.legacyStats = legacyStats;
    res.json(responsePayload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reports/export', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    let { start, end, agent, agentName, agentSearchType, campaign, callType, phone, callId, customerName, afterCallWork, transfers, conferences, abandoned, sort } = req.query;

    const cleanParam = (val) => (!val || val === 'undefined' || val === 'null') ? null : val;
    start = cleanParam(start);
    end = cleanParam(end);
    agent = cleanParam(agent);
    agentName = cleanParam(agentName);
    agentSearchType = cleanParam(agentSearchType);
    campaign = cleanParam(campaign);
    callType = cleanParam(callType);
    phone = cleanParam(phone);
    callId = cleanParam(callId);
    customerName = cleanParam(customerName);
    afterCallWork = cleanParam(afterCallWork);
    transfers = cleanParam(transfers);
    conferences = cleanParam(conferences);
    abandoned = cleanParam(abandoned);

    if (typeof phone === 'string') phone = phone.trim();
    if (typeof callId === 'string') callId = callId.trim();
    if (typeof customerName === 'string') customerName = customerName.trim();
    if (typeof agentName === 'string') agentName = agentName.trim();
    if (typeof agentSearchType === 'string') agentSearchType = agentSearchType.trim().toLowerCase();
    if (typeof afterCallWork === 'string') afterCallWork = afterCallWork.trim();
    if (typeof transfers === 'string') transfers = transfers.trim();
    if (typeof conferences === 'string') conferences = conferences.trim();
    if (typeof abandoned === 'string') abandoned = abandoned.trim();
    if (phone === '') phone = null;
    if (callId === '') callId = null;
    if (customerName === '') customerName = null;
    if (agentName === '') agentName = null;
    if (agentSearchType === '') agentSearchType = null;
        if (!agentName && agent && agentSearchType === 'name') {
          agentName = agent;
          agent = null;
        } else if (!agent && agentName && agentSearchType === 'email') {
          agent = agentName;
          agentName = null;
        } else if (agent && !agentName && !agentSearchType && !/@/.test(agent)) {
          agentName = agent;
          agent = null;
        }
    if (afterCallWork === '') afterCallWork = null;
    if (transfers === '') transfers = null;
    if (conferences === '') conferences = null;
    if (abandoned === '') abandoned = null;

    const startFormatted = normalizeReportTimestamp(start);
    const endFormatted = normalizeReportTimestamp(end);

    const parseInteger = (value) => {
      if (value === null || value === undefined) return null;
      const num = Number.parseInt(value, 10);
      return Number.isNaN(num) ? null : num;
    };
    const parseBinary = (value) => {
      const num = parseInteger(value);
      return (num === 0 || num === 1) ? num : null;
    };

    const afterCallWorkValue = parseInteger(afterCallWork);
    const transfersValue = parseBinary(transfers);
    const conferencesValue = parseBinary(conferences);
    const abandonedValue = parseBinary(abandoned);

    const sortDir = sort === 'asc' ? 'asc' : 'desc';
    const exportResult = exportReports({
      start: startFormatted || null,
      end: endFormatted || null,
      agent,
      agentName,
      campaign,
      callType,
      phone,
      callId,
      customerName,
      afterCallWork: afterCallWorkValue,
      transfers: transfersValue,
      conferences: conferencesValue,
      abandoned: abandonedValue,
      sort: sortDir
    });

    if (exportResult.error) {
      throw new Error(exportResult.error);
    }

    if (exportResult.truncated) {
      return res.status(400).json({
        error: `Too many matching report rows (${exportResult.total}). Narrow your filters to export fewer than ${exportResult.maxRows} rows.`,
        total: exportResult.total,
        maxRows: exportResult.maxRows
      });
    }

    const hydratedRows = hydrateReportRows(exportResult.rows);
    const nowIso = new Date().toISOString().replace(/[:]/g, '-');

    const csv = buildCsv(hydratedRows, [
      { key: 'call_id', header: 'call_id' },
      { key: 'timestamp', header: 'timestamp' },
      { key: 'campaign', header: 'campaign' },
      { key: 'call_type', header: 'call_type' },
      { key: 'agent', header: 'agent' },
      { key: 'agent_name', header: 'agent_name' },
      { key: 'customer_name', header: 'customer_name' },
      { key: 'disposition', header: 'disposition' },
      { key: 'ani', header: 'ani' },
      { key: 'dnis', header: 'dnis' },
      { key: 'talk_time', header: 'talk_time' },
      { key: 'hold_time', header: 'hold_time' },
      { key: 'queue_wait_time', header: 'queue_wait_time' },
      { key: 'ring_time', header: 'ring_time' },
      { key: 'ivr_time', header: 'ivr_time' },
      { key: 'park_time', header: 'park_time' },
      { key: 'after_call_work_time', header: 'after_call_work_time' },
      { key: 'call_time', header: 'call_time' },
      { key: 'bill_time_rounded', header: 'bill_time_rounded' },
      { key: 'transfers', header: 'transfers' },
      { key: 'conferences', header: 'conferences' },
      { key: 'holds', header: 'holds' },
      { key: 'abandoned', header: 'abandoned' },
      { key: 'cost', header: 'cost' },
      { key: 'recordings', header: 'recordings' },
      { key: 'hasRecording', header: 'has_recording', accessor: (row) => row?.hasRecording ? '1' : '0' }
    ]);

    try {
      logAuditEvent(
        req.user.id,
        req.user.email,
        'REPORT_DOWNLOAD',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          report: 'five9_reports',
          filters: {
            start: start || null,
            end: end || null,
            agent: agent || null,
            agentName: agentName || null,
            agentSearchType: agentSearchType || null,
            agentName: agentName || null,
            campaign: campaign || null,
            callType: callType || null,
            phone: phone || null,
            callId: callId || null,
            customerName: customerName || null,
            afterCallWorkMin: afterCallWorkValue,
            transfers: transfersValue,
            conferences: conferencesValue,
            abandoned: abandonedValue
          },
          exported: hydratedRows.length,
          total: exportResult.total,
          sort: sortDir
        }
      );
    } catch (auditErr) {
      console.warn('REPORT_DOWNLOAD audit log failed:', auditErr.message);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="five9-reports-${nowIso}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting reports:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message });
  }
});

// Distinct meta for dropdowns
app.get('/api/reports/meta', requireAuth, ensureSession, async (req, res) => {
  try {
    const campaigns = getDistinctCampaigns();
    const callTypes = getDistinctCallTypes();
    try {
      logAuditEvent(
        req.user.id,
        req.user.email,
        'REPORT_META_VIEW',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        { campaigns: campaigns.length, callTypes: callTypes.length }
      );
    } catch (e) {
      console.warn('REPORT_META_VIEW audit log failed:', e.message);
    }
    res.json({ success:true, campaigns, callTypes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug summary endpoint for reporting (admin only for safety)
app.get('/api/reports/summary', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const summary = getReportingSummary();
    res.json({ success:true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public endpoint to get client configuration
app.get('/api/config', (req, res) => {
  res.json({
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    allowedLoginConfig: {
      allowAll: allowedLoginConfig.allowAll,
      entries: Array.isArray(allowedLoginConfig.entries) ? [...allowedLoginConfig.entries] : []
    }
  });
});

// Logout endpoint to track user logout events
// Middleware to ensure session row exists after requireAuth sets req.user
async function ensureSession(req, res, next) {
  try {
    if (!req.user) return next();
    // Quick check: if last login was within 10 seconds but no session row created (edge), we can create
    // Simpler: attempt to create a session only if no open session exists (logout_time is NULL)
    // We'll query DB minimally.
    const now = Date.now();
    const maxHours = parseInt(process.env.MAX_SESSION_HOURS || '4');
    const maxMs = maxHours * 3600 * 1000;
    const openSession = getUserSessions(req.user.id, null, null, 3, 0).find(s => !s.logout_time);
    if (openSession) {
      const started = new Date(openSession.login_time).getTime();
      const ageMs = now - started;
      const MAX_ACTIVE_WINDOW_MIN = parseInt(process.env.MAX_ACTIVE_WINDOW_MIN || '30');
      let idleMinutes = null;
      if (openSession.last_activity) {
        const lastActivityMs = new Date(openSession.last_activity).getTime();
        idleMinutes = (now - lastActivityMs) / 60000;
      }
      if (ageMs > maxMs) {
        // Age exceeds max session hours threshold.
        // If user was idle (no activity within last MAX_ACTIVE_WINDOW_MIN) -> hard logout & 401.
        // If there WAS activity (idleMinutes <= threshold) -> silent rotate session (close + new) so user continues seamlessly.
        const idleExceeded = idleMinutes === null || idleMinutes > MAX_ACTIVE_WINDOW_MIN;
        if (idleExceeded) {
          try {
            // Hard logout path
            logUserLogout(req.user.id);
            logAuditEvent(
              req.user.id,
              req.user.email,
              'LOGOUT',
              null,
              null,
              req.user.ipAddress,
              req.user.userAgent,
              openSession.id,
              { reason: 'auto_expire_idle_hard', maxHours, idleMinutes, maxIdleMinutes: MAX_ACTIVE_WINDOW_MIN, login_time: openSession.login_time }
            );
          } catch (e) {
            console.error('Error logging hard logout:', e);
          }
          return res.status(401).json({ error: 'Session expired due to inactivity threshold at renewal point' });
        } else {
          // Silent rotation path
            try {
              logUserLogout(req.user.id);
              logAuditEvent(
                req.user.id,
                req.user.email,
                'LOGOUT',
                null,
                null,
                req.user.ipAddress,
                req.user.userAgent,
                openSession.id,
                { reason: 'auto_expire_rotate', maxHours, idleMinutes, maxIdleMinutes: MAX_ACTIVE_WINDOW_MIN, login_time: openSession.login_time }
              );
              const newSessionId = logUserSession(req.user.id, req.user.email, req.user.ipAddress, req.user.userAgent);
              logAuditEvent(
                req.user.id,
                req.user.email,
                'LOGIN',
                null,
                null,
                req.user.ipAddress,
                req.user.userAgent,
                newSessionId,
                { reason: 'rotated_session_after_active_expiry', previousSessionId: openSession.id }
              );
              req.currentSessionId = newSessionId;
              return next();
            } catch (e) {
              console.error('Error rotating session:', e);
            }
        }
      }
  // Touch activity timestamp for active session
  touchUserSession(req.user.id);
  req.currentSessionId = openSession.id;
    } else {
      const sessionId = logUserSession(req.user.id, req.user.email, req.user.ipAddress, req.user.userAgent);
      logAuditEvent(
        req.user.id,
        req.user.email,
        'LOGIN',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        sessionId,
        { reason: 'ensure_session_create' }
      );
      req.currentSessionId = sessionId;
    }
  } catch (e) {
    console.error('ensureSession error:', e);
  }
  next();
}

app.post('/api/logout', requireAuth, ensureSession, (req, res) => {
  try {
    // Log the logout event
    logAuditEvent(
      req.user.id, 
      req.user.email, 
      'LOGOUT', 
      null, 
      null, 
      req.user.ipAddress, 
      req.user.userAgent, 
      null, 
      { userRole: req.user.role }
    );
    
    // Update the user session to mark logout time
    logUserLogout(req.user.id);
    
    res.json({ success: true, message: 'Logout recorded' });
  } catch (error) {
    console.error('Error logging logout:', error);
    res.status(500).json({ error: 'Failed to record logout' });
  }
});

async function listWavFilesFromS3(bucket, prefix = "") {
  let files = [];
  let ContinuationToken;
  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken,
    });
    const response = await s3.send(command);
    if (response.Contents) {
      files.push(...response.Contents
        .filter(obj => obj.Key.endsWith(".wav"))
        .map(obj => obj.Key));
    }
    ContinuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return files;
}

// Stream a .wav file, transcoding and caching in S3 if needed
// Audio streaming endpoint with role-based access control
// Health check endpoint with FFmpeg verification
app.get('/api/health', async (req, res) => {
  try {
    // Check if FFmpeg is available
    const ffmpegCheck = spawn('ffmpeg', ['-version']);
    let ffmpegVersion = '';
    
    ffmpegCheck.stdout.on('data', (data) => {
      if (!ffmpegVersion) ffmpegVersion = data.toString().split('\n')[0];
    });
    
    ffmpegCheck.on('close', (code) => {
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        ffmpeg: code === 0 ? { available: true, version: ffmpegVersion } : { available: false, error: 'FFmpeg not found' },
        cache: fileIndexes ? `${Object.keys(fileIndexes).length} files indexed` : 'Index not loaded'
      };
      res.json(status);
    });
    
    ffmpegCheck.on('error', () => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        ffmpeg: { available: false, error: 'FFmpeg not installed' },
        cache: fileIndexes ? `${Object.keys(fileIndexes).length} files indexed` : 'Index not loaded'
      });
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Authenticated audio streaming endpoint (now uses requireAuth so req.user is available)
app.get('/api/audio/*', requireAuth, ensureSession, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    const region = process.env.AWS_REGION;
    const forceNoCache = req.query.nocache === '1' || req.query.force === '1';
    const debugMode = req.query.debug === '1';
    const requestId = crypto.randomBytes(4).toString('hex');
    const startedTs = Date.now();
    console.log(`🎧 [AUDIO][${requestId}] Incoming stream request file="${filename}" bucket=${BUCKET_NAME} region=${region} forceNoCache=${forceNoCache}`);
    if (!BUCKET_NAME) {
      console.error(`❌ [AUDIO][${requestId}] AWS_BUCKET not configured`);
      return res.status(500).json({ error: 'Audio storage not configured' });
    }
    
    console.log(`🎵 [STREAMING AUTH] User ${req.user.email} (${req.user.role || 'no-role'}) streaming: ${filename}`);

    const s3Key = filename.startsWith('recordings/') ? filename : `recordings/${filename}`;
    const cacheKey = 'cache/wav/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.wav';
    const waveformCacheKey = 'cache/waveform/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.json';
    
    console.log(`🎵 [STREAMING] Checking cache for: ${s3Key}`);
    console.log(`📁 [CACHE KEY] Audio: ${cacheKey}, Waveform: ${waveformCacheKey}`);

    // Check if already cached
    if (!forceNoCache) {
      const cachedHead = headCacheGet(cacheKey);
      if (cachedHead) {
        console.log(`⚡ [CACHE HIT][${requestId}] (HEAD cache) ${cacheKey}`);
        req._playAudit = { cacheHit: true, cachedHead: true };
        const range = req.headers.range;
        const params = { Bucket: BUCKET_NAME, Key: cacheKey };
        if (range) { params.Range = range; res.status(206); }
        await acquireAudioS3();
        try {
          const cachedFetchStart = Date.now();
          const cachedResponse = await s3.send(new GetObjectCommand(params));
          console.log(`⚡ [CACHE FETCH][${requestId}] Stream start after ${Date.now()-cachedFetchStart}ms`);
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('Content-Disposition', `inline; filename="${s3Key.split('/').pop()}"`);
          if (cachedResponse.ContentLength) res.setHeader('Content-Length', cachedResponse.ContentLength);
          if (cachedResponse.ContentRange) res.setHeader('Content-Range', cachedResponse.ContentRange);
          cachedResponse.Body.on('error', e=> console.error(`❌ [CACHE STREAM ERR][${requestId}]`, e));
          res.on('close', ()=> console.log(`📤 [CACHE STREAM CLOSED][${requestId}] durationMs=${Date.now()-startedTs}`));
          cachedResponse.Body.pipe(res);
          releaseAudioS3();
          return;
        } catch (e) {
          releaseAudioS3();
          console.warn(`⚠️ [CACHE FETCH FAIL][${requestId}] proceeding to convert: ${e.message}`);
        }
      } else {
        try {
          const headStarted = Date.now();
          await acquireAudioS3();
          const headPromise = s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: cacheKey }));
          const headResult = await Promise.race([
            headPromise,
            new Promise((_, reject) => setTimeout(()=> reject(new Error('Head timeout after 5000ms')), 5000))
          ]);
          releaseAudioS3();
          if (headResult) {
            headCacheSet(cacheKey, true);
            console.log(`⚡ [CACHE HIT][${requestId}] Found cached file in ${Date.now()-headStarted}ms: ${cacheKey}`);
            req._playAudit = { cacheHit: true };
            const range = req.headers.range;
            const params = { Bucket: BUCKET_NAME, Key: cacheKey };
            if (range) { params.Range = range; res.status(206); }
            await acquireAudioS3();
            const cachedFetchStart = Date.now();
            const cachedResponse = await s3.send(new GetObjectCommand(params));
            releaseAudioS3();
            console.log(`⚡ [CACHE FETCH][${requestId}] Stream start after ${Date.now()-cachedFetchStart}ms`);
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Content-Disposition', `inline; filename="${s3Key.split('/').pop()}"`);
            if (cachedResponse.ContentLength) res.setHeader('Content-Length', cachedResponse.ContentLength);
            if (cachedResponse.ContentRange) res.setHeader('Content-Range', cachedResponse.ContentRange);
            cachedResponse.Body.on('error', e=> console.error(`❌ [CACHE STREAM ERR][${requestId}]`, e));
            res.on('close', ()=> console.log(`📤 [CACHE STREAM CLOSED][${requestId}] durationMs=${Date.now()-startedTs}`));
            cachedResponse.Body.pipe(res);
            return;
          }
        } catch (e) {
          releaseAudioS3();
          console.log(`📦 [CACHE MISS][${requestId}] (${e.message}) Need to convert: ${s3Key}`);
          req._playAudit = { cacheHit: false, headError: e.message };
        }
      }
    } else {
      console.log(`🚫 [CACHE BYPASS][${requestId}] Forced conversion due to query param`);
      req._playAudit = { cacheHit: false, forced: true };
    }

    // Emit a single consolidated PLAY_FILE audit event now that we know cache hit/miss
    try {
      const meta = parseFileMetadata(filename) || {};
      const cacheInfo = req._playAudit ? req._playAudit.cacheHit : null;
      logAuditEvent(
        req.user.id,
        req.user.email,
        'PLAY_FILE',
        filename,
        meta,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        { cacheHit: cacheInfo, userRole: req.user.role, callId: meta.callId || meta.call_id || null, durationMs: meta.durationMs || meta.duration_ms || meta.durationMs }
      );
    } catch (e) {
      console.error('⚠️ [AUDIT PLAY] Consolidated log failed:', e);
    }

    // Get the original file from S3
    const s3StartTime = Date.now();
    let originalResponse;
    try {
      const originalCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key });
      // Implement manual timeout using AbortController (AWS SDK v3 supports abortSignal)
      const controller = new AbortController();
      const timeoutMs = parseInt(process.env.AUDIO_S3_TIMEOUT_MS || '20000', 10);
      const tHandle = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      originalResponse = await s3.send(originalCommand, { abortSignal: controller.signal });
      clearTimeout(tHandle);
      const s3FetchTime = Date.now() - s3StartTime;
      console.log(`📦 [S3 FETCH][${requestId}] Retrieved file in ${s3FetchTime}ms size=${originalResponse.ContentLength || 'unknown'} timeoutMs=${timeoutMs}`);
      recordS3Success();
    } catch (e) {
      console.error(`❌ [S3 FETCH FAIL][${requestId}] ${e.name||''} ${e.message}`);
      recordS3Failure(`${e.name || 'Error'} ${e.message}`.trim());
      return res.status(404).json({ error: 'Original file not found', detail: e.message });
    }

    // Convert and cache for seeking support
    const tmpCachePath = path.join(os.tmpdir(), cacheKey.replace(/\//g, '_'));
    
  console.log(`🔄 [CONVERT][${requestId}] Starting FFmpeg WAV conversion: ${s3Key}`);
    const conversionStartTime = Date.now();
    
    // Ensure we do not exceed concurrent ffmpeg processes
    await acquireFfmpegSlot();
    
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', debugMode ? 'info' : (process.env.FFMPEG_LOGLEVEL || 'warning'),
      '-nostdin',
      '-i', 'pipe:0',            // Input from stdin
      '-fflags', '+discardcorrupt',
      '-err_detect', 'ignore_err', // treat minor decode errors as non-fatal
      '-f', 'wav',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', FFMPEG_OUTPUT_HZ,
      '-y',                      // overwrite temp file if exists
      tmpCachePath
    ];
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
  console.log(`🎬 [FFMPEG SPAWN][${requestId}] cmd=ffmpeg args=${ffmpegArgs.join(' ')}`);

    // Error handling
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (/Packet is too small/i.test(msg)) {
        console.warn(`⚠️  [FFmpeg WARN][${requestId}] ${msg.trim()}`);
      } else {
        console.log(`[FFmpeg][stderr][${requestId}] ${msg.trim()}`);
      }
    });

    ffmpeg.on('error', (error) => {
      console.error(`❌ [FFmpeg ERROR][${requestId}]:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Audio conversion failed' });
      }
      if (fs.existsSync(tmpCachePath)) fs.unlinkSync(tmpCachePath);
      releaseFfmpegSlot();
    });

    // Stream input to FFmpeg
    let sourceEnded = false;
    originalResponse.Body.on('error', e => {
      console.error(`❌ [S3 BODY ERR][${requestId}]`, e.message);
      try { ffmpeg.stdin.destroy(e); } catch {}
    });
    originalResponse.Body.on('end', () => {
      sourceEnded = true;
      console.log(`📥 [S3 BODY END][${requestId}] upstream complete`);
      try { ffmpeg.stdin.end(); } catch {}
    });
    originalResponse.Body.pipe(ffmpeg.stdin);
    console.log(`🔌 [PIPE][${requestId}] S3->FFmpeg piping established`);

    ffmpeg.on('close', async (code) => {
      const conversionTime = Date.now() - conversionStartTime;
      console.log(`⏱️ [CONVERSION][${requestId}] Completed in ${conversionTime}ms exitCode=${code}`);
      if (!sourceEnded) {
        console.log(`⚠️ [CONVERSION][${requestId}] FFmpeg closed before source end (sourceEnded=${sourceEnded})`);
      }
      
      // Even if non-zero, sometimes partial output exists; validate file size
      let tmpOk = false;
      try {
        if (fs.existsSync(tmpCachePath)) {
          const st = fs.statSync(tmpCachePath);
            tmpOk = st.size > 1024; // require minimal size
        }
      } catch {}
      if (code !== 0 && !tmpOk) {
  console.error(`❌ [FFMPEG BAD OUTPUT][${requestId}] exitCode=${code} sizeInvalid`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to convert audio' });
        }
        if (fs.existsSync(tmpCachePath)) fs.unlinkSync(tmpCachePath);
        releaseFfmpegSlot();
        return;
      }

      try {
        // Upload to S3 cache
        const fileData = fs.readFileSync(tmpCachePath);
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: cacheKey,
          Body: fileData,
          ContentType: 'audio/wav'
        }));
        
  console.log(`✅ [CACHED][${requestId}] Uploaded to S3 cache: ${cacheKey} size=${fileData.length}`);
        
        // Now serve the file with range support
        const range = req.headers.range;
        if (range) {
          // Handle range request for seeking
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileData.length - 1;
          const chunksize = (end - start) + 1;
          
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${fileData.length}`);
          res.setHeader('Content-Length', chunksize);
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Accept-Ranges', 'bytes');
          
          res.end(fileData.slice(start, end + 1));
          console.log(`📤 [RANGE SERVE][${requestId}] bytes=${chunksize} range=${start}-${end}`);
        } else {
          // Serve full file
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', fileData.length);
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('Content-Disposition', `inline; filename="${s3Key.split('/').pop()}"`);
          
          res.end(fileData);
          console.log(`📤 [FULL SERVE][${requestId}] bytes=${fileData.length}`);
        }
        
        // Clean up temp file
        fs.unlinkSync(tmpCachePath);
        
      } catch (error) {
        console.error(`❌ Error caching or serving file:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to serve converted audio' });
        }
        if (fs.existsSync(tmpCachePath)) fs.unlinkSync(tmpCachePath);
      }
      releaseFfmpegSlot();
      console.log(`🏁 [AUDIO DONE][${requestId}] totalMs=${Date.now()-startedTs}`);
    });
  } catch (err) {
    console.error('Error streaming S3 file:', err);
    res.status(404).json({ error: 'File not found' });
  }
});

// Waveform endpoint - returns waveform data for an audio file
app.get('/api/waveform/*', async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    
    // Handle authentication
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.substring(7);
    } else if (req.query.auth) {
      token = req.query.auth;
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // TODO: Add proper JWT verification and domain checking for waveform endpoint
    console.log(`📊 [WAVEFORM AUTH] Token provided for: ${filename}`);

    const s3Key = filename.startsWith('recordings/') ? filename : `recordings/${filename}`;
    const waveformCacheKey = 'cache/waveform/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.json';
    
    console.log(`📊 [WAVEFORM] Checking cache for: ${s3Key}`);

    // Check if waveform already cached
    try {
      const waveformCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: waveformCacheKey });
      const waveformResponse = await s3.send(waveformCommand);
      const waveformData = JSON.parse(await waveformResponse.Body.transformToString());
      
      console.log(`⚡ [WAVEFORM CACHE HIT] Serving cached waveform for: ${s3Key}`);
      res.json({ waveform: waveformData, cached: true });
      return;
      
    } catch {
      console.log(`📦 [WAVEFORM CACHE MISS] Need to generate for: ${s3Key}`);
    }

    // Generate waveform from the SAME converted audio that gets played back
    // First, check if we have the converted audio in cache
    const audioCacheKey = 'cache/wav/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.wav';
    let audioSource = null;
    let useConvertedAudio = false;

    try {
      // Try to use the converted audio cache first
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: audioCacheKey }));
      audioSource = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: audioCacheKey });
      useConvertedAudio = true;
      console.log(`🎯 [WAVEFORM] Using converted audio cache for perfect sync: ${audioCacheKey}`);
    } catch {
      // Fall back to original audio
      audioSource = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key });
      console.log(`📄 [WAVEFORM] Using original audio (will convert): ${s3Key}`);
    }

    const audioResponse = await s3.send(audioSource);

    console.log(`🔄 [WAVEFORM] Starting synchronized FFmpeg analysis for: ${s3Key}`);
    const waveformStartTime = Date.now();

    // FFmpeg parameters depend on whether we're using converted audio or original
    let ffmpegArgs;
    if (useConvertedAudio) {
      // Already converted WAV - just extract PCM data
      ffmpegArgs = [
        '-i', 'pipe:0',
        '-f', 's16le',            // Raw 16-bit PCM for analysis
        '-acodec', 'pcm_s16le',   
        'pipe:1'                  // No conversion needed - already mono 22050Hz
      ];
      console.log(`🎯 [WAVEFORM] Using pre-converted audio (already mono 22050Hz)`);
    } else {
      // Original audio - apply EXACT SAME conversion as playback
      ffmpegArgs = [
        '-i', 'pipe:0',
        '-f', 's16le',            // Raw 16-bit PCM for analysis
        '-acodec', 'pcm_s16le',   // Same codec as playback
        '-ac', '1',               // Convert to mono (same as playback)
        '-ar', '22050',           // Convert sample rate (same as playback)
        'pipe:1'
      ];
      console.log(`🔄 [WAVEFORM] Converting original audio (mono 22050Hz)`);
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let audioData = Buffer.alloc(0);
    
    ffmpeg.stdout.on('data', (chunk) => {
      audioData = Buffer.concat([audioData, chunk]);
    });

    ffmpeg.stderr.on('data', (data) => {
      // Suppress FFmpeg stderr for waveform generation
    });

    ffmpeg.on('error', (error) => {
      console.error('❌ [WAVEFORM FFmpeg ERROR]:', error);
      res.status(500).json({ error: 'Waveform generation failed' });
    });

    audioResponse.Body.pipe(ffmpeg.stdin);

    ffmpeg.on('close', async (code) => {
      if (code !== 0) {
        console.error(`❌ [WAVEFORM] FFmpeg process exited with code ${code}`);
        res.status(500).json({ error: 'Failed to generate waveform' });
        return;
      }

      // Process audio data into waveform with proper timing alignment
      const samples = [];
      const sampleSize = 2; // 16-bit = 2 bytes
      const expectedSampleRate = 22050; // Hz (expected after conversion)
      const targetPoints = 1000; // Target number of waveform points
      const totalSamples = Math.floor(audioData.length / sampleSize);
      const samplesPerPoint = Math.floor(totalSamples / targetPoints);
      
      // Calculate actual duration for verification
      const durationSeconds = totalSamples / expectedSampleRate;

      console.log(`📊 [WAVEFORM ANALYSIS] Source: ${useConvertedAudio ? 'converted cache' : 'original file'}`);
      console.log(`📊 [WAVEFORM ANALYSIS] Duration: ${durationSeconds.toFixed(1)}s, Total samples: ${totalSamples}, Samples per point: ${samplesPerPoint}`);
      console.log(`📊 [WAVEFORM ANALYSIS] Audio data size: ${audioData.length} bytes, Expected sample rate: ${expectedSampleRate}Hz`);

      for (let i = 0; i < targetPoints; i++) {
        let maxAmplitude = 0;
        let rmsSum = 0;
        let count = 0;
        
        for (let j = 0; j < samplesPerPoint; j++) {
          const sampleIndex = i * samplesPerPoint + j;
          const offset = sampleIndex * sampleSize;
          
          if (offset + 1 < audioData.length) {
            // Read 16-bit signed integer
            const sample = audioData.readInt16LE(offset);
            const amplitude = Math.abs(sample);
            
            // Track peak amplitude for this segment
            maxAmplitude = Math.max(maxAmplitude, amplitude);
            
            // Also calculate RMS for smoothness
            rmsSum += sample * sample;
            count++;
          }
        }
        
        if (count > 0) {
          // Use combination of peak and RMS for better dynamics
          const rms = Math.sqrt(rmsSum / count);
          const peakNormalized = maxAmplitude / 32768;
          const rmsNormalized = rms / 32768;
          
          // Blend peak (for dynamics) and RMS (for smoothness)
          const finalAmplitude = (peakNormalized * 0.7) + (rmsNormalized * 0.3);
          
          // Apply some compression to enhance visibility of quiet parts
          const compressed = Math.pow(finalAmplitude, 0.6); // Square root compression
          
          samples.push(Math.min(compressed, 1));
        } else {
          samples.push(0);
        }
      }

      const waveformTime = Date.now() - waveformStartTime;
      console.log(`✅ [WAVEFORM] Generated ${samples.length} points in ${waveformTime}ms`);
      
      // Log amplitude distribution for debugging
      const maxVal = Math.max(...samples);
      const minVal = Math.min(...samples);
      const avgVal = samples.reduce((a, b) => a + b, 0) / samples.length;
      console.log(`📈 [WAVEFORM STATS] Min: ${minVal.toFixed(3)}, Max: ${maxVal.toFixed(3)}, Avg: ${avgVal.toFixed(3)}`);

      // Cache the waveform data
      try {
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: waveformCacheKey,
          Body: JSON.stringify(samples),
          ContentType: 'application/json'
        }));
        console.log(`💾 [WAVEFORM CACHED] Saved to: ${waveformCacheKey}`);
      } catch (cacheError) {
        console.error('⚠️ [WAVEFORM CACHE] Failed to cache:', cacheError);
      }

      res.json({ 
        waveform: samples, 
        cached: false, 
        generationTime: waveformTime,
        duration: durationSeconds,
        sampleRate: expectedSampleRate,
        totalSamples: totalSamples,
        source: useConvertedAudio ? 'converted_cache' : 'original_file'
      });
    });

  } catch (error) {
    console.error('❌ [WAVEFORM ERROR]:', error);
    res.status(500).json({ error: 'Waveform generation failed' });
  }
});

// Download endpoint with role-based access control
app.get('/api/download/*', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    
    console.log(`📥 [DOWNLOAD] User ${req.user.email} (${req.user.role}) downloading: ${filename}`);
    try {
      // Attempt to parse metadata for richer audit details
      const meta = parseFileMetadata(filename) || {};
      logAuditEvent(
        req.user.id,
        req.user.email,
        'DOWNLOAD_FILE',
        filename,
        meta,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          userRole: req.user.role,
          date: meta.callDate || meta.date || null,
            time: meta.callTime || meta.time || null,
            callId: meta.callId || meta.call_id || null,
            durationMs: meta.durationMs || meta.duration_ms || null
        }
      );
    } catch (auditErr) {
      console.error('⚠️ [AUDIT] Failed to log download event:', auditErr);
    }

    const s3Key = filename.startsWith('recordings/') ? filename : `recordings/${filename}`;
    
    // Force download with proper headers
    try {
      const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key });
      const s3Response = await s3.send(command);

      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `attachment; filename="${s3Key.split('/').pop()}"`);
      res.setHeader('Content-Length', s3Response.ContentLength || 0);

      s3Response.Body.pipe(res);
    } catch (error) {
      console.error('Download error:', error);
      res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    console.error('Error downloading file:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// High-performance files endpoint using database - requires authentication
app.get('/api/wav-files', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const {
      dateStart,
      dateEnd,
      offset = 0,
      limit = 25,
      phone,
      email,
      durationMin,
      durationMode = "min",
      timeStart,
      timeEnd,
      timeMode = "range",
      sortColumn = "date",
      sortDirection = "desc"
    } = req.query;

    // Email filtering - allow all users to view all files (no email filtering)
    let effectiveEmail = email?.trim() || null;
    
    // All authenticated users can view all files
    console.log(`📄 [VIEW_FILES] User ${req.user.email} viewing file list`);
    try {
      logAuditEvent(
        req.user.id,
        req.user.email,
        'VIEW_FILES',
        null,
        phone?.trim() || null,
        req.user.ipAddress,
        req.user.userAgent,
        null,
        {
          userRole: req.user.role,
          dateStart: dateStart || null,
          dateEnd: dateEnd || null,
          durationMin: durationMin ? parseInt(durationMin) : null,
          timeStart: timeStart || null,
            timeEnd: timeEnd || null,
          sort: `${sortColumn}:${sortDirection}`,
          offset: parseInt(offset) || 0,
          limit: parseInt(limit) || 25
        }
      );
    } catch (auditErr) {
      console.error('⚠️ [AUDIT] Failed to log view files event:', auditErr);
    }
    
    // Note: Download protection is handled at the audio streaming level

    // Use database query for ultra-fast results
    const result = queryFiles({
      dateStart,
      dateEnd,
      phone: phone?.trim() || null,
      email: effectiveEmail,
      durationMin: durationMin ? parseInt(durationMin) : null,
      timeStart,
      timeEnd,
      callId: req.query.callId ? req.query.callId.trim() : null,
      sortColumn,
      sortDirection,
      limit: parseInt(limit) || 25,
      offset: parseInt(offset) || 0
    });

    res.json({
      files: result.files.map(f => ({
        path: f.file_path,
        phone: f.phone,
        email: f.email,
        date: f.call_date,
        time: f.call_time,
        callId: f.call_id,
        durationMs: f.duration_ms,
        size: f.file_size
      })),
      totalCount: result.totalCount,
      offset: parseInt(offset) || 0,
      limit: parseInt(limit) || 25,
      hasMore: result.hasMore
    });

  } catch (err) {
    console.error('Error in /api/wav-files:', err);
    res.status(500).json({ files: [], totalCount: 0, offset: 0, limit: 25, hasMore: false });
  }
});

// Database sync/indexing endpoint for initial setup and maintenance
app.post('/api/sync-database', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const BUCKET_NAME = process.env.AWS_BUCKET;
    const { dateRange, forceReindex = false } = req.body || {};

    console.log(`📊 [SYNC] ${dateRange ? 'Date range' : 'Full'} sync requested`);

    console.log('Starting database sync...');
    const startTime = Date.now();
    let indexedCount = 0;

    if (dateRange) {
      // Sync specific date range
      const { startDate, endDate } = dateRange;
      const start = dayjs(startDate, "M_D_YYYY");
      const end = dayjs(endDate, "M_D_YYYY");
      let current = start.clone();

      while (current.isSameOrBefore(end, "day")) {
        const dayPrefix = `recordings/${current.format("M_D_YYYY")}/`;
        console.log(`Indexing files for ${current.format("M_D_YYYY")}...`);
        
        const dayFiles = await listWavFilesFromS3(BUCKET_NAME, dayPrefix);
        if (dayFiles.length > 0) {
          const batchIndexed = indexFiles(dayFiles);
          indexedCount += batchIndexed;
          console.log(`Indexed ${batchIndexed}/${dayFiles.length} files for ${current.format("M_D_YYYY")}`);
        }
        
        current = current.add(1, "day");
      }
    } else {
      // Full sync - be careful with 300k+ files!
      console.log('WARNING: Full sync initiated - this may take a while...');
      const allFiles = await listWavFilesFromS3(BUCKET_NAME, 'recordings/');
      console.log(`Found ${allFiles.length} total files to index`);
      
      // Process in batches of 1000 for memory efficiency
      const batchSize = 1000;
      for (let i = 0; i < allFiles.length; i += batchSize) {
        const batch = allFiles.slice(i, i + batchSize);
        const batchIndexed = indexFiles(batch);
        indexedCount += batchIndexed;
        
        console.log(`Batch ${Math.floor(i/batchSize) + 1}: Indexed ${batchIndexed}/${batch.length} files (Total: ${indexedCount}/${allFiles.length})`);
        
        // Brief pause to prevent overwhelming the system
        if (i + batchSize < allFiles.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    
    const stats = getDatabaseStats();
    
    res.json({
      success: true,
      indexedFiles: indexedCount,
      duration: `${duration.toFixed(2)}s`,
      databaseStats: stats
    });

  } catch (err) {
    console.error('Error syncing database:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Database statistics endpoint
app.get('/api/database-stats', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const stats = getDatabaseStats();
    res.json(stats);
  } catch (err) {
    console.error('Error getting database stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Audit logs endpoint - admin only
app.get('/api/audit-logs', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const {
      userId,
      actionType,
      startDate,
      endDate,
      callId,
      limit = 100,
      offset = 0
    } = req.query;

    const { rows: auditLogs, total } = getAuditLogs(
      userId || null,
      actionType || null,
      startDate || null,
      endDate || null,
      callId || null,
      parseInt(limit),
      parseInt(offset)
    );

    res.json({
      logs: auditLogs,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + auditLogs.length < total
      }
    });
  } catch (err) {
    console.error('Error getting audit logs:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit-logs/export', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const {
      userId,
      actionType,
      startDate,
      endDate,
      callId
    } = req.query;

    const exportResult = exportAuditLogs({
      userId: userId || null,
      actionType: actionType || null,
      startDate: startDate || null,
      endDate: endDate || null,
      callId: callId || null
    });

    if (exportResult.error) {
      throw new Error(exportResult.error);
    }

    if (exportResult.truncated) {
      return res.status(400).json({
        error: `Too many matching audit rows (${exportResult.total}). Narrow your filters to export fewer than ${exportResult.maxRows} rows.`,
        total: exportResult.total,
        maxRows: exportResult.maxRows
      });
    }

    const nowIso = new Date().toISOString().replace(/[:]/g, '-');
    const csv = buildCsv(exportResult.rows, [
      { key: 'id', header: 'id' },
      { key: 'user_id', header: 'user_id' },
      { key: 'user_email', header: 'user_email' },
      { key: 'action_type', header: 'action_type' },
      { key: 'file_path', header: 'file_path' },
      { key: 'call_id', header: 'call_id' },
      { key: 'action_timestamp', header: 'action_timestamp' },
      { key: 'ip_address', header: 'ip_address' },
      { key: 'user_agent', header: 'user_agent' },
      { key: 'session_id', header: 'session_id' },
      { key: 'additional_data', header: 'additional_data' }
    ]);

    try {
      logAuditEvent(
        req.user.id,
        req.user.email,
        'REPORT_DOWNLOAD',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          report: 'audit_logs',
          filters: { userId: userId || null, actionType: actionType || null, startDate: startDate || null, endDate: endDate || null, callId: callId || null },
          exported: exportResult.rows.length
        }
      );
    } catch (auditErr) {
      console.warn('REPORT_DOWNLOAD audit log failed:', auditErr.message);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${nowIso}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting audit logs:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message });
  }
});

// Maintenance endpoint to backfill missing audit log call_ids from additional_data JSON
app.post('/api/backfill-audit-callids', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { batchSize } = req.body || {};
    const result = backfillAuditLogCallIds(batchSize || 500);
    logAuditEvent(req.auth.userId, req.auth.user?.primaryEmailAddress?.emailAddress || '', 'MAINTENANCE', null, null, getClientIp(req), req.headers['user-agent'] || '', req.sessionId, { task: 'backfill_audit_call_ids', ...result });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Error backfilling audit call_ids:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/reporting/user-usage', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const rows = getUserUsageReport(startDate || null, endDate || null);

    const payloadRows = rows.map(row => ({
      userId: row.user_id,
      userEmail: row.user_email,
      totalActions: row.total_actions,
      loginCount: row.login_count,
      logoutCount: row.logout_count,
      playCount: row.play_count,
      downloadCount: row.download_count,
      viewCount: row.view_count,
      reportViewCount: row.report_view_count,
      reportDownloadCount: row.report_download_count,
      lastActionAt: row.last_action_at,
      totalSessionMs: row.total_session_ms,
      totalSessionMinutes: row.total_session_ms ? Math.round(row.total_session_ms / 60000) : 0
    }));

    const summary = payloadRows.reduce((acc, row) => {
      acc.totalUsers += 1;
      acc.totalActions += row.totalActions;
      acc.loginCount += row.loginCount;
      acc.downloadCount += row.downloadCount;
      acc.playCount += row.playCount;
      acc.reportViewCount += row.reportViewCount;
      acc.reportDownloadCount += row.reportDownloadCount;
      acc.totalSessionMinutes += row.totalSessionMinutes;
      return acc;
    }, {
      totalUsers: 0,
      totalActions: 0,
      loginCount: 0,
      downloadCount: 0,
      playCount: 0,
      reportViewCount: 0,
      reportDownloadCount: 0,
      totalSessionMinutes: 0
    });

    try {
      logAuditEvent(
        req.user.id,
        req.user.email,
        'REPORT_VIEW',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          report: 'user_usage',
          filters: { startDate: startDate || null, endDate: endDate || null },
          returned: payloadRows.length
        }
      );
    } catch (auditErr) {
      console.warn('REPORT_VIEW audit log failed:', auditErr.message);
    }

    res.json({ success: true, rows: payloadRows, summary });
  } catch (err) {
    console.error('Error loading user usage report:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reporting/user-usage/export', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const exportResult = exportUserUsageReport(startDate || null, endDate || null);

    if (exportResult.truncated) {
      return res.status(400).json({
        error: `Too many users (${exportResult.total}) to export. Narrow the date range to fewer than ${exportResult.maxRows} rows.`,
        total: exportResult.total,
        maxRows: exportResult.maxRows
      });
    }

    const nowIso = new Date().toISOString().replace(/[:]/g, '-');
    const csv = buildCsv(exportResult.rows, [
      { key: 'user_id', header: 'user_id' },
      { key: 'user_email', header: 'user_email' },
      { key: 'total_actions', header: 'total_actions' },
      { key: 'login_count', header: 'login_count' },
      { key: 'logout_count', header: 'logout_count' },
      { key: 'play_count', header: 'play_count' },
      { key: 'download_count', header: 'download_count' },
      { key: 'view_count', header: 'view_count' },
      { key: 'report_view_count', header: 'report_view_count' },
      { key: 'report_download_count', header: 'report_download_count' },
      { key: 'last_action_at', header: 'last_action_at' },
      {
        key: 'total_session_ms',
        header: 'total_session_minutes',
        accessor: (row) => row.total_session_ms ? Math.round(row.total_session_ms / 60000) : 0
      }
    ]);

    try {
      logAuditEvent(
        req.user.id,
        req.user.email,
        'REPORT_DOWNLOAD',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          report: 'user_usage',
          filters: { startDate: startDate || null, endDate: endDate || null },
          exported: exportResult.rows.length
        }
      );
    } catch (auditErr) {
      console.warn('REPORT_DOWNLOAD audit log failed:', auditErr.message);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="user-usage-${nowIso}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting user usage report:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message });
  }
});

// User sessions endpoint - admin only
app.get('/api/user-sessions', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const {
      userId,
      startDate,
      endDate,
      limit = 100,
      offset = 0
    } = req.query;

    const sessions = getUserSessions(
      userId || null,
      startDate || null,
      endDate || null,
      parseInt(limit),
      parseInt(offset)
    );

    res.json({
      sessions,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: sessions.length === parseInt(limit)
      }
    });
  } catch (err) {
    console.error('Error getting user sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Session repair & backfill endpoint - admin only
app.post('/api/repair-sessions', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { simulate = false, keepLatestOpen = true, maxHours = 4, includeBackfill = true } = req.body || {};
    const repairPreview = repairOpenSessions({ keepLatestOpen });
    let backfillResult = { closed: 0, details: [] };
    if (includeBackfill) {
      backfillResult = backfillExpiredOpenSessions(maxHours);
    }
    if (!simulate) {
      // Log maintenance audit event summarizing actions (no specific file)
      logAuditEvent(
        req.user.id,
        req.user.email,
        'MAINTENANCE',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          maintenance: 'repair_sessions',
          keepLatestOpen,
          maxHours,
          includeBackfill,
          sessionsClosed: repairPreview.sessionsClosed + backfillResult.closed,
          duplicateClosed: repairPreview.sessionsClosed,
          expiredBackfilled: backfillResult.closed,
          usersAffected: repairPreview.usersAffected
        }
      );
    }
    res.json({
      simulate: !!simulate,
      keepLatestOpen,
      maxHours,
      includeBackfill,
      duplicateRepair: repairPreview,
      expiredBackfill: backfillResult,
      totalClosed: repairPreview.sessionsClosed + backfillResult.closed
    });
  } catch (e) {
    console.error('Error repairing sessions:', e);
    res.status(500).json({ error: e.message });
  }
});

// File metadata backfill (duration/callId) - admin only
app.post('/api/backfill-files', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { batchSize = 500 } = req.body || {};
    const result = backfillFileMetadata(Math.min(parseInt(batchSize) || 500, 5000));
    logAuditEvent(
      req.user.id,
      req.user.email,
      'MAINTENANCE',
      null,
      null,
      req.user.ipAddress,
      req.user.userAgent,
      req.currentSessionId || null,
      { maintenance: 'backfill_file_metadata', ...result }
    );
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Backfill endpoint error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Autocomplete distinct users (admin only)
app.get('/api/audit-users', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const users = getDistinctUsers(q || null, Math.min(parseInt(limit) || 20, 100));
    res.json({ users });
  } catch (err) {
    console.error('Error getting distinct users:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve React static files
app.use(express.static(BUILD_DIR));

// Fallback: serve index.html for any non-API route
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(BUILD_DIR, 'index.html'));
  }
});

// Auto-sync function for current day
async function syncCurrentDay() {
  try {
    const BUCKET_NAME = process.env.AWS_BUCKET;
    const today = dayjs().format("M_D_YYYY");
    const dayPrefix = `recordings/${today}/`;
    
    console.log(`🔄 [AUTO-SYNC] Checking current day: ${today}`);
    
    const dayFiles = await listWavFilesFromS3(BUCKET_NAME, dayPrefix);
    
    if (dayFiles.length > 0) {
      const indexedCount = indexFiles(dayFiles);
      console.log(`✅ [AUTO-SYNC] Indexed ${indexedCount}/${dayFiles.length} files for ${today}`);
    } else {
      console.log(`📁 [AUTO-SYNC] No files found for ${today}`);
    }
  } catch (error) {
    console.error(`❌ [AUTO-SYNC] Error during current day sync:`, error.message);
  }
}

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
  
  // Start automatic current day sync every 5 minutes
  console.log(`🕒 [AUTO-SYNC] Starting automatic current day sync (every 5 minutes)`);
  
  // Run initial sync after 30 seconds (give server time to fully start)
  setTimeout(() => {
    console.log(`🚀 [AUTO-SYNC] Running initial current day sync...`);
    syncCurrentDay();
  }, 30000);
  
  // Then run every 5 minutes
  setInterval(syncCurrentDay, 5 * 60 * 1000); // 5 minutes in milliseconds
});
