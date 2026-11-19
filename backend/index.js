import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { spawn } from 'child_process';
import crypto from 'crypto';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import utcPlugin from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';
import fs from 'fs';
import path from 'path';
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
import { initializeDatabase, pool, queryFiles, indexFiles, indexFile, getDatabaseStats, getAuditLogs, getUserSessions, logAuditEvent, parseFileMetadata, logUserLogout, logUserSession, getDistinctUsers, expireStaleSessions, touchUserSession, expireInactiveSessions, repairOpenSessions, backfillExpiredOpenSessions, backfillFileMetadata, backfillAuditLogCallIds, queryReports, exportReports, getReportingSummary, getDistinctCampaigns, getDistinctCallTypes, getDistinctDispositions, getDistinctFileDispositions, exportAuditLogs, getUserUsageReport, exportUserUsageReport, normalizeReportTimestamp, getLegacyReportTimestampStats, rewriteReportTimestamps, getCallIdsWithRecordings, closeUserSession, getOpenSessionId, getRecordingContext, addFavorite, removeFavorite, getFavoriteState, getRecordingActivity, addComment, deleteComment, commentExists, getCommenterEmails, createNotifications, deleteUnreadFavoriteNotifications, deleteCommentNotifications, getNotifications, markNotificationsRead, getTranscription, getCallAnalysis, deleteCallAnalysis, getRecordingReport, insertNewFiles, fillFileAgents, getRecentFilesMissingFive9, runFileAgentBackfill, getAgentDashboard, getAgentScoreHistory, getTeamLeaderboard, saveFive9TeamSnapshot, getSupervisedGroups, getAllFive9Groups, getGroupAgents, getFive9TeamStatus, getTeamScoreChange, searchTranscripts, getTrends, listCoachingItems, getCoachingCounts, getCoachingItemForFile, addCoachingItem, updateCoachingItem, getSuggestedCoaching } from './database.js';
import { computeBadges } from './badges.js';
import { createAgentDirectory } from './agentDirectory.js';
import { createRecordingScan } from './recordingScan.js';
import { startTranscriptionWorker, MIN_DURATION_MS, SKIP_DISPOSITIONS } from './transcription.js';
import { fetchLastHourCallLog, fetchCallLog, five9Configured, five9AdminCall, scheduleRecurringIngestion } from './five9.js';
import { syncFive9Teams } from './five9Teams.js';
import { createAudioCache, pipeToResponse, waveformCacheKey as waveformKeyFor } from './audioCache.js';
import { monitorEventLoopDelay } from 'perf_hooks';
import { logtoAuth, requireAuth, requireAdmin, requireMemberOrAdmin, requireAuthenticatedUser, requireManagerOrAdmin, allowedLoginConfig, ROLE_SCOPES, ROLE_NAMES, USE_ROLE_NAMES } from './auth.js';

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
// Gzip JSON, HTML, JS and CSS. Audio (audio/wav) isn't compressible, so streams are untouched.
app.use(compression());

// Logs API requests that take 500ms or more, so slow spots show up in the logs.
const SLOW_REQUEST_MS = 500;
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms >= SLOW_REQUEST_MS && !req.path.startsWith('/api/audio/') && !req.path.startsWith('/api/download/')) {
      console.log(`⏱️ [SLOW] ${req.method} ${req.path} ${res.statusCode} ${Math.round(ms)}ms`);
    }
  });
  next();
});
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

  next();
});

app.use(logtoAuth); // Logto auth (no-op passthrough; tokens verified per-route in requireAuth)

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

async function hydrateReportRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const hydrated = rows.map(hydrateReportRow);

  // hasRecording is now computed via LEFT JOIN in the SQL query.
  // If rows already have it, no extra query needed.
  // Only fall back to the separate query if hasRecording is not present (e.g. export path).
  const needsRecordingLookup = hydrated.length > 0 && hydrated[0].hasRecording === undefined;
  if (needsRecordingLookup) {
    try {
      const callIds = Array.from(new Set(hydrated.map(row => (row && row.call_id ? String(row.call_id) : null)).filter(Boolean)));
      if (callIds.length) {
        const availabilityMap = await getCallIdsWithRecordings(callIds);
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
  }

  // Strip raw_json from response — it's large and only used for hydration above
  for (const row of hydrated) {
    delete row.raw_json;
    delete row.raw_json_parsed;
    delete row.recordings;
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

const audioCache = createAudioCache({
  s3,
  bucket: process.env.AWS_BUCKET,
  outputHz: FFMPEG_OUTPUT_HZ,
  acquireFfmpeg: acquireFfmpegSlot,
  releaseFfmpeg: releaseFfmpegSlot,
  onOriginalFetch: err => (err ? recordS3Failure(`${err.name || 'Error'} ${err.message}`.trim()) : recordS3Success())
});

// Warn when the event loop stalls: a blocked loop fails the healthcheck and times out S3 requests.
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
setInterval(() => {
  const maxMs = loopDelay.max / 1e6;
  if (maxMs > 1000) console.warn(`🐢 [EVENT LOOP] blocked for up to ${Math.round(maxMs)}ms in the last 10s`);
  loopDelay.reset();
}, 10000).unref();

// --- AUTO SESSION EXPIRATION (4h) ---
const MAX_SESSION_HOURS = parseInt(process.env.MAX_SESSION_HOURS || '4');
const MAX_INACTIVITY_MINUTES = parseInt(process.env.MAX_INACTIVITY_MINUTES || '30');
// Run every 5 minutes to catch stale sessions
setInterval(async () => {
  try {
    const expired = await expireStaleSessions(MAX_SESSION_HOURS, 200);
    if (Array.isArray(expired) && expired.length) {
      console.log(`⏰ [SESSION EXPIRY] Auto-logged out ${expired.length} session(s) > ${MAX_SESSION_HOURS}h`);
      for (const row of expired) {
        // Audit each auto logout
        await logAuditEvent(
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
    const inactive = await expireInactiveSessions(MAX_INACTIVITY_MINUTES, 300);
    if (Array.isArray(inactive) && inactive.length) {
      console.log(`💤 [INACTIVITY EXPIRY] Auto-logged out ${inactive.length} inactive session(s) > ${MAX_INACTIVITY_MINUTES}m`);
      for (const row of inactive) {
        await logAuditEvent(
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
    const result = await rewriteReportTimestamps({ batchSize, runAll, includeIso, dryRun });
    const legacy = await getLegacyReportTimestampStats(10);

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
    let { start, end, agent, agentName, agentSearchType, campaign, callType, disposition, phone, callId, customerName, afterCallWork, callTimeMin, callTimeMax, transfers, conferences, abandoned, hasRecording, limit = 100, offset = 0, timezone: userTimezone, sort, sortBy } = req.query;
    
    // Clean up "undefined" strings
    const cleanParam = (val) => (!val || val === 'undefined' || val === 'null') ? null : val;
    start = cleanParam(start);
    end = cleanParam(end);
    agent = cleanParam(agent);
    agentName = cleanParam(agentName);
    agentSearchType = cleanParam(agentSearchType);
    campaign = cleanParam(campaign);
    disposition = cleanParam(disposition);
    hasRecording = cleanParam(hasRecording);
    callType = cleanParam(callType);
    phone = cleanParam(phone);
    callId = cleanParam(callId);
    customerName = cleanParam(customerName);
    afterCallWork = cleanParam(afterCallWork);
    callTimeMin = cleanParam(callTimeMin);
    callTimeMax = cleanParam(callTimeMax);
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

    console.log(`[API /api/reports] Query params: start="${start}", end="${end}", userTz="${userTimezone}", agent="${agent}", agentName="${agentName}", agentSearchType="${agentSearchType}", campaign="${campaign}", callType="${callType}", phone="${phone}", callId="${callId}", customerName="${customerName}", afterCallWork="${afterCallWork}", callTimeMin="${callTimeMin}", callTimeMax="${callTimeMax}", transfers="${transfers}", conferences="${conferences}", abandoned="${abandoned}", limit=${limit}, offset=${offset}`);
    
    const startFormatted = normalizeReportTimestamp(start);
    const endFormatted = normalizeReportTimestamp(end);
    
    if (startFormatted || endFormatted) {
      console.log(`[API /api/reports] Formatted for SQLite: start="${startFormatted}", end="${endFormatted}"`);
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
    const callTimeMinValue = parseInteger(callTimeMin);
    const callTimeMaxValue = parseInteger(callTimeMax);
    const transfersValue = parseBinary(transfers);
    const conferencesValue = parseBinary(conferences);
    const abandonedValue = parseBinary(abandoned);
    const hasRecordingValue = parseBinary(hasRecording);

    const sortDir = sort === 'asc' ? 'asc' : 'desc';
    const sortByValue = sortBy === 'callTime' ? 'callTime' : 'timestamp';
    const result = await queryReports({
      start: appliedStart,
      end: appliedEnd,
      agent,
      agentName,
      campaign,
      callType,
      disposition,
      phone,
      callId,
      customerName,
      afterCallWork: afterCallWorkValue,
      callTimeMin: callTimeMinValue,
      callTimeMax: callTimeMaxValue,
      transfers: transfersValue,
      conferences: conferencesValue,
      abandoned: abandonedValue,
      hasRecording: hasRecordingValue,
      limit: appliedLimit,
      offset: appliedOffset,
      sort: sortDir,
      sortBy: sortByValue
    });
      const hydratedRows = await hydrateReportRows(result.rows);
      // Rows may be ordered by call time, so take the extremes rather than the first and last row.
      const returnedTimestamps = (hydratedRows || []).map(row => row.timestamp).filter(Boolean).sort();
      const returnedRange = { min: returnedTimestamps[0] || null, max: returnedTimestamps[returnedTimestamps.length - 1] || null };
    console.log(`[API /api/reports] Applied range: start="${appliedStart}" end="${appliedEnd}" limit=${appliedLimit} offset=${appliedOffset} sortBy=${sortByValue} sort=${sortDir}`);
    console.log(`[API /api/reports] Returned range: min="${returnedRange.min}" max="${returnedRange.max}" total=${result.total}`);

    let legacyStats = null;
    if (/^true$/i.test(process.env.REPORT_TIME_DEBUG || '')) {
      legacyStats = await getLegacyReportTimestampStats(5);
      console.log(`[API /api/reports] Legacy timestamp rows remaining=${legacyStats.total}`);
      if (legacyStats.total && legacyStats.samples?.length) {
        legacyStats.samples.forEach((sample, idx) => {
          console.log(`   [legacy ${idx + 1}] call_id=${sample.call_id} timestamp="${sample.timestamp}"`);
        });
      }
    }
    try {
      await logAuditEvent(
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
          pagination: { limit: appliedLimit, offset: appliedOffset, sort: sortDir, sortBy: sortByValue },
                    returned: hydratedRows ? hydratedRows.length : 0,
          // null when the count was skipped (page 2+) — don't record that as a real zero
          total: result.total ?? null,
          totalCapped: result.totalCapped || false,
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

app.get('/api/reports/export', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    let { start, end, agent, agentName, agentSearchType, campaign, callType, disposition, phone, callId, customerName, afterCallWork, callTimeMin, callTimeMax, transfers, conferences, abandoned, hasRecording, sort, sortBy } = req.query;

    const cleanParam = (val) => (!val || val === 'undefined' || val === 'null') ? null : val;
    start = cleanParam(start);
    end = cleanParam(end);
    agent = cleanParam(agent);
    agentName = cleanParam(agentName);
    agentSearchType = cleanParam(agentSearchType);
    campaign = cleanParam(campaign);
    disposition = cleanParam(disposition);
    hasRecording = cleanParam(hasRecording);
    callType = cleanParam(callType);
    phone = cleanParam(phone);
    callId = cleanParam(callId);
    customerName = cleanParam(customerName);
    afterCallWork = cleanParam(afterCallWork);
    callTimeMin = cleanParam(callTimeMin);
    callTimeMax = cleanParam(callTimeMax);
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
    const callTimeMinValue = parseInteger(callTimeMin);
    const callTimeMaxValue = parseInteger(callTimeMax);
    const transfersValue = parseBinary(transfers);
    const conferencesValue = parseBinary(conferences);
    const abandonedValue = parseBinary(abandoned);
    const hasRecordingValue = parseBinary(hasRecording);

    const sortDir = sort === 'asc' ? 'asc' : 'desc';
    const sortByValue = sortBy === 'callTime' ? 'callTime' : 'timestamp';
    const exportResult = await exportReports({
      start: startFormatted || null,
      end: endFormatted || null,
      agent,
      agentName,
      campaign,
      callType,
      disposition,
      phone,
      callId,
      customerName,
      afterCallWork: afterCallWorkValue,
      callTimeMin: callTimeMinValue,
      callTimeMax: callTimeMaxValue,
      transfers: transfersValue,
      conferences: conferencesValue,
      abandoned: abandonedValue,
      hasRecording: hasRecordingValue,
      sort: sortDir,
      sortBy: sortByValue
    });

    if (exportResult.error) {
      throw new Error(exportResult.error);
    }

    if (exportResult.truncated) {
      // The count stops at maxRows + 1, so we know it's over the limit but not by how much.
      return res.status(400).json({
        error: `Too many matching report rows (more than ${exportResult.maxRows}). Narrow your filters to export fewer than ${exportResult.maxRows} rows.`,
        total: null,
        maxRows: exportResult.maxRows
      });
    }

    const hydratedRows = await hydrateReportRows(exportResult.rows);
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
      await logAuditEvent(
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
            callTimeMin: callTimeMinValue,
            callTimeMax: callTimeMaxValue,
            transfers: transfersValue,
            conferences: conferencesValue,
            abandoned: abandonedValue
          },
          exported: hydratedRows.length,
          total: exportResult.total,
          sort: sortDir,
          sortBy: sortByValue
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
    const [campaigns, callTypes, dispositions] = await Promise.all([
      getDistinctCampaigns(),
      getDistinctCallTypes(),
      getDistinctDispositions()
    ]);
    try {
      await logAuditEvent(
        req.user.id,
        req.user.email,
        'REPORT_META_VIEW',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        { campaigns: campaigns.length, callTypes: callTypes.length, dispositions: dispositions.length }
      );
    } catch (e) {
      console.warn('REPORT_META_VIEW audit log failed:', e.message);
    }
    res.json({ success:true, campaigns, callTypes, dispositions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug summary endpoint for reporting (admin only for safety)
app.get('/api/reports/summary', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const summary = await getReportingSummary();
    res.json({ success:true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public endpoint to get client configuration
app.get('/api/config', (req, res) => {
  res.json({
    logtoEndpoint: process.env.LOGTO_ENDPOINT,
    logtoAppId: process.env.LOGTO_APP_ID,
    logtoApiResource: process.env.LOGTO_API_RESOURCE,
    // scope -> role mapping, and the list of permission scopes the SPA should request
    roleScopes: ROLE_SCOPES,
    apiScopes: Object.values(ROLE_SCOPES),
    // role-name -> app-role mapping (fallback source: token `roles` claim), and
    // whether that fallback is enabled — the frontend gate must match the
    // backend exactly or users pass the UI gate and then get 403 on every call.
    roleNames: ROLE_NAMES,
    useRoleNames: USE_ROLE_NAMES,
    allowedLoginConfig: {
      allowAll: allowedLoginConfig.allowAll,
      entries: Array.isArray(allowedLoginConfig.entries) ? [...allowedLoginConfig.entries] : []
    }
  });
});

// Logout endpoint to track user logout events
// Middleware to ensure session row exists after requireAuth sets req.user
// Inactivity timeouts are measured in minutes, so a once-a-minute touch is enough.
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
const sessionTouchedAt = new Map();

async function ensureSession(req, res, next) {
  try {
    if (!req.user) return next();
    // Quick check: if last login was within 10 seconds but no session row created (edge), we can create
    // Simpler: attempt to create a session only if no open session exists (logout_time is NULL)
    // We'll query DB minimally.
    const now = Date.now();
    const maxHours = parseInt(process.env.MAX_SESSION_HOURS || '4');
    const maxMs = maxHours * 3600 * 1000;
    const openSession = (await getUserSessions(req.user.id, null, null, 3, 0)).find(s => !s.logout_time);
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
            // Hard logout path. Concurrent requests race to close this same
            // session; only the one that actually closes it logs the LOGOUT.
            if (await closeUserSession(openSession.id)) {
              await logAuditEvent(
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
            }
          } catch (e) {
            console.error('Error logging hard logout:', e);
          }
          return res.status(401).json({ error: 'Session expired due to inactivity threshold at renewal point' });
        } else {
          // Silent rotation path
            try {
              // Concurrent requests race to rotate this same session: only the
              // one that closes it logs the LOGOUT, and only the one that opens
              // the replacement logs the LOGIN.
              if (await closeUserSession(openSession.id)) {
                await logAuditEvent(
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
              }
              const newSessionId = await logUserSession(req.user.id, req.user.email, req.user.ipAddress, req.user.userAgent);
              if (newSessionId) {
                await logAuditEvent(
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
              }
              req.currentSessionId = newSessionId ?? await getOpenSessionId(req.user.id);
              return next();
            } catch (e) {
              console.error('Error rotating session:', e);
            }
        }
      }
  // Touch activity timestamp for active session
  // At most one last_activity write per user per minute, not one per request.
  if (Date.now() - (sessionTouchedAt.get(req.user.id) || 0) >= SESSION_TOUCH_INTERVAL_MS) {
    sessionTouchedAt.set(req.user.id, Date.now());
    await touchUserSession(req.user.id);
  }
  req.currentSessionId = openSession.id;
    } else {
      const sessionId = await logUserSession(req.user.id, req.user.email, req.user.ipAddress, req.user.userAgent);
      // null: a concurrent request opened the session first and logged the LOGIN.
      if (sessionId) {
        await logAuditEvent(
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
      }
      req.currentSessionId = sessionId ?? await getOpenSessionId(req.user.id);
    }
  } catch (e) {
    console.error('ensureSession error:', e);
  }
  next();
}

app.post('/api/logout', requireAuth, ensureSession, async (req, res) => {
  try {
    // Log the logout event
    await logAuditEvent(
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
    await logUserLogout(req.user.id);
    
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

    // A recently converted copy on local disk serves seeks fastest.
    const localCopy = !forceNoCache && audioCache.localEntry(cacheKey);
    if (localCopy) {
      console.log(`⚡ [LOCAL HIT][${requestId}] ${cacheKey}`);
      return audioCache.serveLocal(localCopy, cacheKey, req, res, s3Key.split('/').pop());
    }

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
          res.on('close', ()=> console.log(`📤 [CACHE STREAM CLOSED][${requestId}] durationMs=${Date.now()-startedTs}`));
          pipeToResponse(cachedResponse.Body, res, `[${requestId}]`);
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
            res.on('close', ()=> console.log(`📤 [CACHE STREAM CLOSED][${requestId}] durationMs=${Date.now()-startedTs}`));
            pipeToResponse(cachedResponse.Body, res, `[${requestId}]`);
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
      ).catch(e => console.error('⚠️ [AUDIT PLAY] Consolidated log failed:', e));
    } catch (e) {
      console.error('⚠️ [AUDIT PLAY] Consolidated log failed:', e);
    }

    // Convert once (shared by concurrent requests), then stream from disk while the S3 cache upload runs.
    const conversionStartTime = Date.now();
    let converted;
    try {
      converted = await audioCache.getOrConvert(s3Key, cacheKey, {
        timeoutMs: parseInt(process.env.AUDIO_S3_TIMEOUT_MS || '20000', 10),
        loglevel: debugMode ? 'info' : (process.env.FFMPEG_LOGLEVEL || 'warning')
      });
    } catch (e) {
      console.error(`❌ [CONVERT FAIL][${requestId}] ${e.message}`);
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.status === 404 ? 'Original file not found' : 'Failed to convert audio', detail: e.message });
      return;
    }
    console.log(`⏱️ [CONVERSION][${requestId}] ready in ${Date.now() - conversionStartTime}ms shared=${!!converted.shared} size=${converted.entry.size}`);
    audioCache.serveLocal(converted.entry, cacheKey, req, res, s3Key.split('/').pop());
  } catch (err) {
    console.error('Error streaming S3 file:', err);
    res.status(404).json({ error: 'File not found' });
  }
});

// Waveform endpoint - returns waveform data for an audio file
// Same access rule as /api/audio: a verified, allow-listed user with an app role
// and an active session may load any recording's waveform.
app.get('/api/waveform/*', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;

    console.log(`📊 [WAVEFORM AUTH] User ${req.user.email} (${req.user.role}) loading waveform: ${filename}`);

    const s3Key = filename.startsWith('recordings/') ? filename : `recordings/${filename}`;

    try {
      const cached = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: waveformKeyFor(s3Key) }));
      const waveformData = JSON.parse(await cached.Body.transformToString());
      return res.json({ waveform: waveformData, cached: true });
    } catch {
      console.log(`📦 [WAVEFORM CACHE MISS] Need to generate for: ${s3Key}`);
    }

    const result = await audioCache.getWaveform(s3Key);
    console.log(`✅ [WAVEFORM] ${s3Key} ${result.waveform.length} points from ${result.source}, ${result.duration.toFixed(1)}s audio in ${result.generationTime}ms`);
    res.json({ ...result, cached: false });
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
      await logAuditEvent(
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

      pipeToResponse(s3Response.Body, res, ' [DOWNLOAD]');
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
    
    // Audit VIEW_FILES only on the initial page load/refresh (frontend sends
    // logView=1 on its first fetch), not on every filter/sort/pagination fetch.
    if (req.query.logView === '1') {
      console.log(`📄 [VIEW_FILES] User ${req.user.email} viewing file list`);
      try {
        await logAuditEvent(
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
            durationMax: req.query.durationMax ? parseInt(req.query.durationMax) : null,
            hasTranscript: ['0', '1'].includes(req.query.hasTranscript) ? req.query.hasTranscript : null,
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
    }
    
    // Note: Download protection is handled at the audio streaming level

    // Use database query for ultra-fast results
    const result = await queryFiles({
      dateStart,
      dateEnd,
      phone: phone?.trim() || null,
      email: effectiveEmail,
      durationMin: durationMin ? parseInt(durationMin) : null,
      durationMax: req.query.durationMax ? parseInt(req.query.durationMax) : null,
      hasTranscript: ['0', '1'].includes(req.query.hasTranscript) ? req.query.hasTranscript : null,
      timeStart,
      timeEnd,
      callId: req.query.callId ? req.query.callId.trim() : null,
      callDisposition: req.query.callDisposition?.trim() || null,
      scoreMax: req.query.scoreMax ?? null,
      // Favorites views, "Only my calls" and single-recording links. The
      // viewer's email always comes from the token, never the query string.
      recordingPath: readRecordingPath(req.query.path),
      favorites: ['mine', 'any'].includes(req.query.favorites) ? req.query.favorites : null,
      mine: req.query.mine === '1',
      // "My team": always the signed-in manager's own team, never from the query string.
      agentEmails: req.query.team === '1' ? (await teamFor(req.user)).members.map(m => m.email) : undefined,
      viewerEmail: req.user.email.toLowerCase(),
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
        callDisposition: f.call_disposition,
        durationMs: f.duration_ms,
        size: f.file_size,
        favoriteCount: f.favorite_count,
        commentCount: f.comment_count,
        favoritedByMe: f.favorited_by_me,
        overallScore: f.overall_score,
        agentEmail: f.agent_email,
        agentName: f.agent_name,
        customerName: f.customer_name,
        isMine: f.is_mine,
        // Members may favorite only their own calls; anyone may remove their own favorite.
        canFavorite: req.user.role !== 'member' || f.is_mine || f.favorited_by_me
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

// Meta endpoint for file filter dropdowns
app.get('/api/wav-files/meta', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const dispositions = await getDistinctFileDispositions();
    res.json({ success: true, dispositions });
  } catch (err) {
    console.error('Error in /api/wav-files/meta:', err);
    res.json({ success: false, dispositions: [] });
  }
});

// ============================================================
// Recording favorites, comments & notifications
// ============================================================
const COMMENT_MAX_LENGTH = 2000;
// One day — far longer than any call — keeps positions within INTEGER range.
const COMMENT_MAX_POSITION_MS = 24 * 60 * 60 * 1000;

// Recording paths are exact files.file_path keys, so they are not trimmed.
function readRecordingPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\u0000') ? value : null;
}

function isModerator(role) {
  return role === 'manager' || role === 'admin';
}

// The signed-in user as stored on favorites, comments and notifications. The
// access token rarely carries names, so the UI falls back to the email.
function recordingActor(req) {
  const { firstName, lastName } = req.user;
  // firstName falls back to the full `name` claim, which may already end with the surname.
  const name = firstName && lastName && !firstName.endsWith(lastName)
    ? `${firstName} ${lastName}`
    : (firstName || lastName || null);
  return { id: req.user.id, email: req.user.email.toLowerCase(), name, role: req.user.role };
}

// `file` is the files row (or parsed filename metadata) so the audit row gets
// phone/email/call id; the Admin audit table reads additional_data.callId.
async function auditRecordingAction(req, actionType, recordingPath, file, extra = {}) {
  await logAuditEvent(
    req.user.id,
    req.user.email,
    actionType,
    recordingPath,
    file,
    req.user.ipAddress,
    req.user.userAgent,
    req.currentSessionId || null,
    { userRole: req.user.role, callId: file?.call_id || file?.callId || null, ...extra }
  );
}

// Notifications are best-effort: never fail a favorite or comment that already saved.
async function updateNotificationsSafely(update) {
  try {
    await update();
  } catch (err) {
    console.error('⚠️ [NOTIFY] Failed to update notifications:', err);
  }
}

function toCommentResponse(comment, actor) {
  return {
    id: comment.id,
    userEmail: comment.user_email,
    userName: comment.user_name,
    userRole: comment.user_role,
    body: comment.body,
    positionMs: comment.position_ms,
    createdAt: comment.created_at,
    canDelete: isModerator(actor.role) || comment.user_email === actor.email
  };
}

// Side-panel data for one recording: who favorited it, and its comments.
app.get('/api/recordings/activity', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const recordingPath = readRecordingPath(req.query.path);
    if (!recordingPath) return res.status(400).json({ error: 'path is required' });

    const context = await getRecordingContext(recordingPath);
    if (!context) return res.status(404).json({ error: 'Recording not found' });

    const actor = recordingActor(req);
    const { favorites, comments } = await getRecordingActivity(recordingPath);
    const favoritedByMe = favorites.some(f => f.user_email === actor.email);
    const isMine = context.ownerEmails.includes(actor.email);
    res.json({
      favoriteCount: favorites.length,
      favoritedByMe,
      isMine,
      canFavorite: actor.role !== 'member' || isMine || favoritedByMe,
      favorites: favorites.map(f => ({ userEmail: f.user_email, userName: f.user_name, userRole: f.user_role, createdAt: f.created_at })),
      comments: comments.map(c => toCommentResponse(c, actor))
    });
  } catch (err) {
    console.error('Error in /api/recordings/activity:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recordings/transcript', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const recordingPath = readRecordingPath(req.query.path);
    if (!recordingPath) return res.status(400).json({ error: 'path is required' });

    const context = await getRecordingContext(recordingPath);
    if (!context) return res.status(404).json({ error: 'Recording not found' });

    const transcription = await getTranscription(recordingPath);
    res.json(transcription || { status: 'none' });
  } catch (err) {
    console.error('Error in /api/recordings/transcript:', err);
    res.status(500).json({ error: err.message });
  }
});

// Everything the call file page shows, in one request.
app.get('/api/recordings/detail', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const recordingPath = readRecordingPath(req.query.path);
    if (!recordingPath) return res.status(400).json({ error: 'path is required' });

    const context = await getRecordingContext(recordingPath);
    if (!context) return res.status(404).json({ error: 'Recording not found' });

    const actor = recordingActor(req);
    const [report, transcription, analysis, activity, coaching] = await Promise.all([
      getRecordingReport(context.file.call_id),
      getTranscription(recordingPath),
      getCallAnalysis(recordingPath),
      getRecordingActivity(recordingPath),
      isModerator(actor.role) ? getCoachingItemForFile(recordingPath) : null
    ]);
    const isMine = context.ownerEmails.includes(actor.email);
    const favoritedByMe = activity.favorites.some(f => f.user_email === actor.email);
    await auditRecordingAction(req, 'VIEW_RECORDING', recordingPath, context.file);
    res.json({
      file: context.file,
      report: report ? { ...report, agent_display_name: agentDirectory.agentName(report.agent) || report.agent_name || null } : null,
      agentName: agentDirectory.agentName(report?.agent || context.file.email),
      transcription: transcription || { status: 'none' },
      analysis,
      activity: {
        favoriteCount: activity.favorites.length,
        favoritedByMe,
        isMine,
        canFavorite: actor.role !== 'member' || isMine || favoritedByMe,
        favorites: activity.favorites.map(f => ({ userEmail: f.user_email, userName: f.user_name, userRole: f.user_role, createdAt: f.created_at })),
        comments: activity.comments.map(c => toCommentResponse(c, actor))
      },
      // Only managers and admins learn whether a call is in the coaching queue.
      coaching: isModerator(actor.role) ? coaching : undefined
    });
  } catch (err) {
    console.error('Error in /api/recordings/detail:', err);
    res.status(500).json({ error: err.message });
  }
});

// Lets the UI label calls that won't be transcribed and scored (too short, or a skipped disposition).
app.get('/api/scoring/config', requireAuth, ensureSession, (req, res) => {
  res.json({ minDurationMs: MIN_DURATION_MS, skipDispositions: SKIP_DISPOSITIONS });
});

// Deletes the call's scorecard so the transcription worker scores it again on its next tick.
app.post('/api/recordings/analysis/rescore', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const recordingPath = readRecordingPath(req.body?.path);
    if (!recordingPath) return res.status(400).json({ error: 'path is required' });
    const context = await getRecordingContext(recordingPath);
    if (!context) return res.status(404).json({ error: 'Recording not found' });
    const deleted = await deleteCallAnalysis(recordingPath);
    await auditRecordingAction(req, 'RESCORE_RECORDING', recordingPath, context.file);
    res.json({ queued: deleted });
  } catch (err) {
    console.error('Error in /api/recordings/analysis/rescore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Agent home, search, trends, coaching
// ============================================================
const APP_TIMEZONE = process.env.FIVE9_TIMEZONE || 'America/Los_Angeles';

// Current and previous period for a Week/Month/Year toggle, as YYYY-MM-DD strings.
// Today: today by hour (compared with yesterday); Week: last 7 days by day;
// Month: last 5 weeks by week; Year: last 12 months by month.
function periodFor(range) {
  const today = dayjs().tz(APP_TIMEZONE).startOf('day');
  let start;
  let bucket;
  if (range === 'today') {
    start = today;
    bucket = 'hour';
  } else if (range === 'year') {
    start = today.startOf('month').subtract(11, 'month');
    bucket = 'month';
  } else if (range === 'month') {
    start = today.subtract(34, 'day');
    bucket = 'week';
  } else {
    start = today.subtract(6, 'day');
    bucket = 'day';
  }
  const days = today.diff(start, 'day') + 1;
  const prevEnd = start.subtract(1, 'day');
  const prevStart = prevEnd.subtract(days - 1, 'day');
  const fmt = d => d.format('YYYY-MM-DD');
  return { start: fmt(start), end: fmt(today), prevStart: fmt(prevStart), prevEnd: fmt(prevEnd), bucket, range: ['today', 'week', 'month', 'year'].includes(range) ? range : 'week' };
}

const agentDirectory = createAgentDirectory({ query: (text, params) => pool.query(text, params) });

// Adds each call row's agent full name (Logto, else Five9, else the email).
const withAgentNames = rows => rows.map(row => ({ ...row, agent_display_name: agentDirectory.agentName(row.agent_email) || row.agent_name || row.agent_email || null }));

// ---- Five9 teams ----
// A manager's team is the agents in the Five9 agent groups where they are a
// supervisor; an admin's team is every Five9 agent (optionally one group).
// Members have no team. Cached briefly; cleared after each sync.
const TEAM_CACHE_MS = 5 * 60 * 1000;
const teamCache = new Map();

async function teamFor(user, group = null) {
  const email = user.email.toLowerCase();
  const isAdmin = user.role === 'admin';
  if (!isAdmin && user.role !== 'manager') return { hasTeam: false, isAdmin: false, groups: [], group: null, members: [] };
  const key = `${email}|${user.role}|${group || ''}`;
  const cached = teamCache.get(key);
  if (cached && Date.now() - cached.at < TEAM_CACHE_MS) return cached.team;

  const groups = isAdmin ? await getAllFive9Groups() : await getSupervisedGroups(email);
  const picked = group && groups.includes(group) ? group : null;
  let members = [];
  if (isAdmin) members = await getGroupAgents(picked ? [picked] : null);
  else if (groups.length) members = await getGroupAgents(picked ? [picked] : groups);
  members = members.map(m => ({ email: m.email, name: agentDirectory.agentName(m.email) || m.name || m.email, groups: m.groups }));
  const team = { hasTeam: members.length > 0, isAdmin, groups, group: picked, members };
  teamCache.set(key, { at: Date.now(), team });
  return team;
}

const TEAM_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TEAM_SYNC_LOCK = 727003;
let lastTeamSync = null;

// Pulls agent groups and users from Five9 and replaces the stored teams.
// Only one container syncs at a time.
async function runTeamSync(trigger) {
  if (!five9Configured) return { skipped: 'Five9 credentials not set' };
  const client = await pool.connect();
  let locked = false;
  try {
    ({ rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [TEAM_SYNC_LOCK]));
    if (!locked) return { skipped: 'another sync is running' };
    const started = Date.now();
    const result = await syncFive9Teams({ call: five9AdminCall, saveSnapshot: saveFive9TeamSnapshot });
    teamCache.clear();
    lastTeamSync = { at: new Date().toISOString(), trigger, ok: true, ...result };
    console.log(`👥 [FIVE9 TEAMS] Synced (${trigger}) in ${Date.now() - started}ms: ${result.groups} groups, ${result.supervisors} supervisors, ${result.agents} agents, ${result.memberships} memberships, ${result.usersWithoutEmail} users without email`);
    return result;
  } catch (err) {
    lastTeamSync = { at: new Date().toISOString(), trigger, ok: false, error: err.message };
    console.error(`❌ [FIVE9 TEAMS] Sync failed (${trigger}); keeping the previous teams:`, err.message);
    throw err;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [TEAM_SYNC_LOCK]).catch(() => {});
    client.release();
  }
}

app.get('/api/teams/me', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const team = await teamFor(req.user, typeof req.query.group === 'string' ? req.query.group : null);
    res.json(team);
  } catch (err) {
    console.error('Error in /api/teams/me:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teams/dashboard', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const team = await teamFor(req.user, typeof req.query.group === 'string' ? req.query.group : null);
    const period = periodFor(req.query.range);
    if (!team.hasTeam) {
      return res.json({ ...team, period, message: team.isAdmin ? 'No Five9 agent groups have been synced yet.' : 'No Five9 agent group lists you as a supervisor.' });
    }
    const emails = team.members.map(m => m.email);
    const [dashboard, leaderboard] = await Promise.all([getAgentDashboard(emails, period), getTeamLeaderboard(emails, period)]);
    const names = new Map(team.members.map(m => [m.email, m.name]));
    res.json({
      ...team,
      period,
      ...dashboard,
      recent: withAgentNames(dashboard.recent),
      worst: withAgentNames(dashboard.worst),
      best: withAgentNames(dashboard.best),
      leaderboard: leaderboard.map(row => ({ ...row, name: names.get(row.email) || row.five9_name || row.email }))
    });
  } catch (err) {
    console.error('Error in /api/teams/dashboard:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/five9/teams/status', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    res.json({ configured: five9Configured, ...(await getFive9TeamStatus()), lastSync: lastTeamSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/five9/teams/sync', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const result = await runTeamSync('manual');
    await logAuditEvent(req.user.id, req.user.email, 'MAINTENANCE', null, null, req.user.ipAddress, req.user.userAgent,
      req.currentSessionId || null, { maintenance: 'five9_team_sync', ...result });
    res.json({ result, status: await getFive9TeamStatus(), lastSync: lastTeamSync });
  } catch (err) {
    res.status(502).json({ error: `Five9 team sync failed: ${err.message}`, lastSync: lastTeamSync });
  }
});

const readEmail = value => (typeof value === 'string' && value.includes('@') && value.length <= 320 ? value.trim().toLowerCase() : null);
const readDate = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

app.get('/api/agents', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim().slice(0, 100) : null;
    let agents = await agentDirectory.getAgentDirectory();
    if (search) {
      const needle = search.toLowerCase();
      agents = agents.filter(a => a.name.toLowerCase().includes(needle) || a.email.includes(needle));
    }
    res.json({ agents });
  } catch (err) {
    console.error('Error in /api/agents:', err);
    res.status(500).json({ error: err.message });
  }
});

// Everyone may view any agent's home page; it defaults to the signed-in user.
app.get('/api/agents/dashboard', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const email = readEmail(req.query.email) || req.user.email.toLowerCase();
    const period = periodFor(req.query.range);
    const week = periodFor('week');
    const [dashboard, history, teamChange] = await Promise.all([
      getAgentDashboard([email], period),
      getAgentScoreHistory([email]),
      getTeamScoreChange(week.start, week.end, week.prevStart, week.prevEnd)
    ]);
    res.json({
      email,
      name: agentDirectory.agentName(email),
      period,
      ...dashboard,
      recent: withAgentNames(dashboard.recent),
      worst: withAgentNames(dashboard.worst),
      best: withAgentNames(dashboard.best),
      ...computeBadges({ email, history, teamChange })
    });
  } catch (err) {
    console.error('Error in /api/agents/dashboard:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search/transcripts', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    if (!q) return res.json({ results: [], total: 0 });
    const result = await searchTranscripts({
      q,
      agent: readEmail(req.query.agent),
      dateStart: readDate(req.query.dateStart),
      dateEnd: readDate(req.query.dateEnd),
      limit: Math.min(parseInt(req.query.limit, 10) || 50, 100),
      offset: Math.max(parseInt(req.query.offset, 10) || 0, 0)
    });
    await logAuditEvent(req.user.id, req.user.email, 'SEARCH_TRANSCRIPTS', null, null, req.user.ipAddress, req.user.userAgent,
      req.currentSessionId || null, { userRole: req.user.role, query: q, total: result.total });
    res.json({ ...result, results: withAgentNames(result.results) });
  } catch (err) {
    console.error('Error in /api/search/transcripts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trends', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const period = periodFor(req.query.range);
    let emails = null;
    let email = null;
    if (req.query.scope === 'agent') {
      email = readEmail(req.query.email) || req.user.email.toLowerCase();
      emails = [email];
    } else if (req.query.scope === 'team') {
      emails = (await teamFor(req.user)).members.map(m => m.email);
    }
    res.json({ period, email, scope: req.query.scope || 'global', ...(await getTrends({ emails, ...period })) });
  } catch (err) {
    console.error('Error in /api/trends:', err);
    res.status(500).json({ error: err.message });
  }
});

const COACHING_STATUSES = ['to_review', 'coached', 'dismissed'];
const COACHING_NOTE_MAX_LENGTH = 2000;
const COACHING_SUGGEST_MAX_SCORE = -3;
const COACHING_SUGGEST_DAYS = 14;

// The coaching queue shows a manager's team by default (scope=team) when they
// have one; scope=all (or no team) shows everyone.
async function coachingScope(req) {
  const team = await teamFor(req.user);
  const wantTeam = req.query.scope ? req.query.scope === 'team' : team.hasTeam;
  return wantTeam ? { scope: 'team', agents: team.members.map(m => m.email) } : { scope: 'all', agents: null };
}

app.get('/api/coaching', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const status = COACHING_STATUSES.includes(req.query.status) ? req.query.status : null;
    const { scope, agents } = await coachingScope(req);
    const filterAgent = readEmail(req.query.agent);
    const scoped = filterAgent ? [filterAgent].filter(e => !agents || agents.includes(e)) : agents;
    const [items, counts] = await Promise.all([
      listCoachingItems({ status, agents: scoped }),
      getCoachingCounts(agents)
    ]);
    res.json({ items: withAgentNames(items), counts, scope });
  } catch (err) {
    console.error('Error in /api/coaching:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/coaching/suggested', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const since = dayjs().tz(APP_TIMEZONE).subtract(COACHING_SUGGEST_DAYS, 'day').format('YYYY-MM-DD');
    const { scope, agents } = await coachingScope(req);
    res.json({ items: withAgentNames(await getSuggestedCoaching(COACHING_SUGGEST_MAX_SCORE, since, 20, agents)), maxScore: COACHING_SUGGEST_MAX_SCORE, days: COACHING_SUGGEST_DAYS, scope });
  } catch (err) {
    console.error('Error in /api/coaching/suggested:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coaching', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const recordingPath = readRecordingPath(req.body?.path);
    if (!recordingPath) return res.status(400).json({ error: 'path is required' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, COACHING_NOTE_MAX_LENGTH) || null : null;
    const context = await getRecordingContext(recordingPath);
    if (!context) return res.status(404).json({ error: 'Recording not found' });
    const item = await addCoachingItem(recordingPath, recordingActor(req), note);
    await auditRecordingAction(req, 'COACHING_ADD', recordingPath, context.file, { coachingId: item.id });
    res.json({ item });
  } catch (err) {
    console.error('Error in POST /api/coaching:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coaching/:id', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const status = req.body?.status === undefined ? undefined : req.body.status;
    if (status !== undefined && !COACHING_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${COACHING_STATUSES.join(', ')}` });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, COACHING_NOTE_MAX_LENGTH) : undefined;
    const item = await updateCoachingItem(id, { status, note });
    if (!item) return res.status(404).json({ error: 'Coaching item not found' });
    const context = await getRecordingContext(item.file_path);
    await auditRecordingAction(req, 'COACHING_UPDATE', item.file_path, context?.file || null, { coachingId: id, status: item.status });
    res.json({ item });
  } catch (err) {
    console.error('Error in POST /api/coaching/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sets (rather than toggles) the caller's favorite, so retries and double-clicks are harmless.
app.post('/api/recordings/favorite', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const recordingPath = readRecordingPath(req.body?.path);
    const favorite = req.body?.favorite;
    if (!recordingPath || typeof favorite !== 'boolean') {
      return res.status(400).json({ error: 'path and favorite (true/false) are required' });
    }

    const actor = recordingActor(req);
    const context = await getRecordingContext(recordingPath);

    if (favorite) {
      if (!context) return res.status(404).json({ error: 'Recording not found' });
      // Members may favorite only their own calls; managers and admins any call.
      if (actor.role === 'member' && !context.ownerEmails.includes(actor.email)) {
        return res.status(403).json({ error: 'Forbidden', message: 'You can only favorite your own recordings.' });
      }
      if (await addFavorite(recordingPath, actor)) {
        await auditRecordingAction(req, 'FAVORITE_ADD', recordingPath, context.file);
        await updateNotificationsSafely(() => createNotifications(
          context.ownerEmails.filter(email => email !== actor.email), 'favorite', recordingPath, actor
        ));
      }
    } else if (await removeFavorite(recordingPath, actor.email)) {
      // Removing is always allowed — even after a role change, or once the
      // recording has dropped out of the index.
      await auditRecordingAction(req, 'FAVORITE_REMOVE', recordingPath, context?.file || parseFileMetadata(recordingPath));
      await updateNotificationsSafely(() => deleteUnreadFavoriteNotifications(recordingPath, actor.email));
    }

    const state = await getFavoriteState(recordingPath, actor.email);
    const isMine = Boolean(context?.ownerEmails.includes(actor.email));
    // e.g. a member who just removed a favorite on a call they don't own can't re-add it.
    res.json({ ...state, canFavorite: actor.role !== 'member' || isMine || state.favoritedByMe });
  } catch (err) {
    console.error('Error in /api/recordings/favorite:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/recordings/comments', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const recordingPath = readRecordingPath(req.body?.path);
    if (!recordingPath) return res.status(400).json({ error: 'path is required' });

    // Postgres TEXT rejects NUL bytes, so strip them before checking the length.
    const rawBody = req.body?.body;
    const body = typeof rawBody === 'string' ? rawBody.replace(/\u0000/g, '').trim() : '';
    if (!body || body.length > COMMENT_MAX_LENGTH) {
      return res.status(400).json({ error: `Comment must be 1-${COMMENT_MAX_LENGTH} characters` });
    }

    const rawPosition = req.body?.positionMs;
    let positionMs = null;
    if (rawPosition !== undefined && rawPosition !== null) {
      if (typeof rawPosition !== 'number' || !Number.isFinite(rawPosition) || rawPosition < 0 || rawPosition > COMMENT_MAX_POSITION_MS) {
        return res.status(400).json({ error: 'positionMs must be a number of milliseconds into the call' });
      }
      positionMs = Math.floor(rawPosition);
    }

    const context = await getRecordingContext(recordingPath);
    if (!context) return res.status(404).json({ error: 'Recording not found' });

    const actor = recordingActor(req);
    const comment = await addComment(recordingPath, actor, body, positionMs);
    await auditRecordingAction(req, 'COMMENT_ADD', recordingPath, context.file, { commentId: comment.id, positionMs, bodyLength: body.length });
    // Notify the call's owner(s) and everyone already in the thread, so a reply
    // reaches the manager who started it.
    await updateNotificationsSafely(async () => {
      const commenters = await getCommenterEmails(recordingPath);
      const recipients = new Set([...context.ownerEmails, ...commenters]);
      recipients.delete(actor.email);
      await createNotifications([...recipients], 'comment', recordingPath, actor, comment.id);
    });

    res.json({ comment: toCommentResponse(comment, actor) });
  } catch (err) {
    console.error('Error in /api/recordings/comments:', err);
    res.status(500).json({ error: err.message });
  }
});

// Authors delete their own comments; managers and admins can delete any.
app.post('/api/recordings/comments/:id/delete', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid comment id' });
    const commentId = Number(req.params.id);

    const actor = recordingActor(req);
    const deleted = await deleteComment(commentId, isModerator(actor.role) ? null : actor.email);
    if (!deleted) {
      return (await commentExists(commentId))
        ? res.status(403).json({ error: 'Forbidden', message: 'You can only delete your own comments.' })
        : res.status(404).json({ error: 'Comment not found' });
    }

    await updateNotificationsSafely(() => deleteCommentNotifications(deleted.file_path, commentId));
    // Comments are hard-deleted, so the audit row keeps the only copy of what was removed.
    const context = await getRecordingContext(deleted.file_path);
    await auditRecordingAction(req, 'COMMENT_DELETE', deleted.file_path, context?.file || parseFileMetadata(deleted.file_path), {
      commentId,
      authorEmail: deleted.user_email,
      body: deleted.body,
      positionMs: deleted.position_ms,
      createdAt: deleted.created_at
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting recording comment:', err);
    res.status(500).json({ error: err.message });
  }
});

// The notification bell calls this only on user-driven events (page load,
// navigation, opening the bell, tab focus) — never on a timer. requireAuth and
// ensureSession count every request as activity, so polling would keep idle
// sessions alive and log phantom LOGINs after they expire.
app.get('/api/notifications', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const { notifications, unreadCount } = await getNotifications(req.user.email.toLowerCase(), limit);
    res.json({
      unreadCount,
      notifications: notifications.map(n => ({
        id: n.id,
        type: n.type,
        filePath: n.file_path,
        actorEmail: n.actor_email,
        actorName: n.actor_name,
        commentExcerpt: n.comment_excerpt,
        createdAt: n.created_at,
        readAt: n.read_at,
        callDate: n.call_date,
        callTime: n.call_time,
        phone: n.phone
      }))
    });
  } catch (err) {
    console.error('Error in /api/notifications:', err);
    res.status(500).json({ error: err.message });
  }
});

// Marks the caller's notifications read: the given ids, or all of them when ids is omitted.
app.post('/api/notifications/read', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
  try {
    const ids = req.body?.ids;
    const validIds = Array.isArray(ids) && ids.length > 0 && ids.length <= 500
      && ids.every(id => Number.isInteger(id) && id > 0 && id <= 2147483647);
    if (ids != null && !validIds) {
      return res.status(400).json({ error: 'ids must be a non-empty array of notification ids' });
    }
    const unreadCount = await markNotificationsRead(req.user.email.toLowerCase(), ids ?? null);
    res.json({ success: true, unreadCount });
  } catch (err) {
    console.error('Error in /api/notifications/read:', err);
    res.status(500).json({ error: err.message });
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
          const batchIndexed = await indexFiles(dayFiles);
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
        const batchIndexed = await indexFiles(batch);
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

    // Copy Five9 agent/customer onto the newly imported recordings, in the background.
    runFileAgentBackfill({ force: true }).catch(err => console.error('❌ [AGENT BACKFILL] Failed after sync:', err.message));

    const stats = await getDatabaseStats();
    
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
app.get('/api/database-stats', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const stats = await getDatabaseStats();
    res.json(stats);
  } catch (err) {
    console.error('Error getting database stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Audit logs endpoint - admin only
app.get('/api/audit-logs', requireAuth, ensureSession, requireAdmin, async (req, res) => {
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

    const { rows: auditLogs, total } = await getAuditLogs(
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

    const exportResult = await exportAuditLogs({
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
      await logAuditEvent(
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
app.post('/api/backfill-audit-callids', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const { batchSize } = req.body || {};
    const result = await backfillAuditLogCallIds(batchSize || 500);
    await logAuditEvent(req.auth.userId, req.auth.user?.primaryEmailAddress?.emailAddress || '', 'MAINTENANCE', null, null, getClientIp(req), req.headers['user-agent'] || '', req.sessionId, { task: 'backfill_audit_call_ids', ...result });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Error backfilling audit call_ids:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/reporting/user-usage', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const rows = await getUserUsageReport(startDate || null, endDate || null);

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
      await logAuditEvent(
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

app.get('/api/reporting/user-usage/export', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const exportResult = await exportUserUsageReport(startDate || null, endDate || null);

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
      await logAuditEvent(
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
app.get('/api/user-sessions', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const {
      userId,
      startDate,
      endDate,
      limit = 100,
      offset = 0
    } = req.query;

    const sessions = await getUserSessions(
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
app.post('/api/repair-sessions', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const { simulate = false, keepLatestOpen = true, maxHours = 4, includeBackfill = true } = req.body || {};
    const repairPreview = await repairOpenSessions({ keepLatestOpen });
    let backfillResult = { closed: 0, details: [] };
    if (includeBackfill) {
      backfillResult = await backfillExpiredOpenSessions(maxHours);
    }
    if (!simulate) {
      // Log maintenance audit event summarizing actions (no specific file)
      await logAuditEvent(
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
app.post('/api/backfill-files', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const { batchSize = 500 } = req.body || {};
    const result = await backfillFileMetadata(Math.min(parseInt(batchSize) || 500, 5000));
    await logAuditEvent(
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
app.get('/api/audit-users', requireAuth, ensureSession, requireAdmin, async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const users = await getDistinctUsers(q || null, Math.min(parseInt(limit) || 20, 100));
    res.json({ users });
  } catch (err) {
    console.error('Error getting distinct users:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve React static files
// Hashed bundles under /static never change, so browsers keep them for a year;
// index.html is always revalidated so a deploy shows up on the next load.
app.use(express.static(BUILD_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}static${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Fallback: serve index.html for any non-API route
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(BUILD_DIR, 'index.html'));
  }
});

// Every 5 minutes: index today's new recordings, fetch their Five9 call log
// rows if missing, and copy the agent and customer onto each recording.
const syncCurrentDay = createRecordingScan({
  listDayFiles: day => listWavFilesFromS3(process.env.AWS_BUCKET, `recordings/${day}/`),
  insertNewFiles,
  fillFileAgents,
  getRecentFilesMissingFive9,
  fetchCallLog,
  five9Configured
});

// Initialize PostgreSQL database and start server
initializeDatabase().then(() => {
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

    startTranscriptionWorker({ s3, bucket: process.env.AWS_BUCKET });

    // One-time: index and fill agent columns on existing recordings (no-op once done).
    runFileAgentBackfill().catch(err => console.error('❌ [AGENT BACKFILL] Failed:', err.message));

    // Five9 agent groups → manager teams: shortly after start, then every 6 hours.
    if (five9Configured) {
      const syncTeams = () => runTeamSync('scheduled').catch(() => {});
      setTimeout(syncTeams, 60 * 1000);
      setInterval(syncTeams, TEAM_SYNC_INTERVAL_MS);
    }

    // Load the agent list now so the first dropdown doesn't wait for it.
    agentDirectory.refresh().catch(err => console.error('❌ [AGENTS] Initial load failed:', err.message));
  });
}).catch(err => {
  console.error('❌ Failed to initialize database:', err);
  process.exit(1);
});
