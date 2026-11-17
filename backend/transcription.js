import axios from 'axios';
import dayjs from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { pool, getFilesNeedingTranscription, getPendingTranscriptions, upsertTranscription, getTranscriptionsMissingSummary, updateTranscriptionSummary } from './database.js';

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const LOOKBACK_DAYS = parseInt(process.env.TRANSCRIBE_LOOKBACK_DAYS || '7', 10);
const MIN_DURATION_SECONDS = parseInt(process.env.TRANSCRIBE_MIN_DURATION_SECONDS || '50', 10);
const PII_POLICIES = (process.env.TRANSCRIBE_PII_POLICIES || [
  'us_social_security_number', 'date_of_birth', 'credit_card_number', 'credit_card_cvv',
  'credit_card_expiration', 'account_number', 'banking_information', 'drivers_license',
  'passport_number', 'email_address', 'phone_number', 'location_address',
  'location_address_street', 'password'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);
const TIMEZONE = process.env.FIVE9_TIMEZONE || 'America/Los_Angeles';

const INTERVAL_MS = 5 * 60 * 1000;
const MAX_SUBMISSIONS_PER_TICK = 10;
// Postgres advisory lock key: only one container runs a tick at a time.
const TRANSCRIBE_LOCK_KEY = 727001;
const SUMMARY_MODEL = process.env.TRANSCRIBE_SUMMARY_MODEL || 'qwen3.5-4b-32k-fast';
// qwen3.5-4b-32k-fast has a 32k-token context; ~80k chars (~20k tokens) leaves room for the prompt and reply.
const MAX_SUMMARY_TRANSCRIPT_CHARS = 80000;
const API_BASE = 'https://api.assemblyai.com/v2';
const LLM_GATEWAY_URL = 'https://llm-gateway.assemblyai.com/v1/chat/completions';
// Without timeouts one hung request would keep the tick, and the cross-container lock, held forever.
const REQUEST_TIMEOUT_MS = 30 * 1000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const SUMMARY_PROMPT = `Summarize this mortgage company phone call in 3-6 short bullet points: the purpose of the call, key details discussed, the outcome, and any next steps. Speakers are labelled by diarization (e.g. "Speaker A") and may be the agent or the customer. Some information has been redacted and appears as placeholders like [PHONE_NUMBER]; keep those placeholders as-is and never guess what they contain. Reply with only the bullet points.`;

const headers = { authorization: API_KEY };

// AssemblyAI's transcript API returns { error }, the LLM Gateway { message, metadata: { errors }, request_id }.
function apiError(err) {
  const data = err.response?.data || {};
  const { error } = data;
  let message = typeof error === 'string' ? error : (error?.message || (error && JSON.stringify(error)));
  if (!message && data.message) {
    const details = Array.isArray(data.metadata?.errors) ? data.metadata.errors.join('; ') : '';
    message = details ? `${data.message} — ${details}` : data.message;
  }
  message = message || err.message;
  if (data.request_id) message += ` (request_id=${data.request_id})`;
  return err.response?.status ? `HTTP ${err.response.status}: ${message}` : message;
}

async function submitRecording(s3, bucket, filePath) {
  const key = filePath.startsWith('recordings/') ? filePath : `recordings/${filePath}`;
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  const upload = await axios.post(`${API_BASE}/upload`, object.Body, {
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      ...(object.ContentLength && { 'content-length': object.ContentLength })
    },
    maxBodyLength: Infinity,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  });
  const { data } = await axios.post(`${API_BASE}/transcript`, {
    audio_url: upload.data.upload_url,
    speaker_labels: true, // recordings are mono, so diarization separates agent and customer
    redact_pii: true,
    redact_pii_policies: PII_POLICIES,
    redact_pii_sub: 'entity_name'
  }, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return data.id;
}

// LLM Gateway tokens-per-minute limit, learned from its X-RateLimit-* headers. Each request
// reserves its prompt tokens + max_tokens, so we pause instead of bursting into 429s.
const SUMMARY_MAX_TOKENS = 400;
const RATE_LIMITED_ERROR = 'Summary failed: rate limited, will retry';
const rateLimit = { pausedUntil: 0, limitTokens: null, remainingTokens: null, resetAt: 0 };

class RateLimitedError extends Error {}

const estimateTokens = text => Math.ceil(text.length / 4) + SUMMARY_MAX_TOKENS;

function readRateHeaders(responseHeaders = {}) {
  const limit = parseInt(responseHeaders['x-ratelimit-limit-tokens'], 10);
  const remaining = parseInt(responseHeaders['x-ratelimit-remaining-tokens'], 10);
  const resetSeconds = parseFloat(responseHeaders['x-ratelimit-reset-tokens']);
  if (!isNaN(limit)) rateLimit.limitTokens = limit;
  rateLimit.remainingTokens = isNaN(remaining) ? null : remaining;
  rateLimit.resetAt = Date.now() + (isNaN(resetSeconds) ? 60 : resetSeconds) * 1000;
}

function pauseSummaries(seconds, reason) {
  rateLimit.pausedUntil = Date.now() + seconds * 1000;
  console.warn(`⏸️ [TRANSCRIBE] Summaries ${reason} (limit=${rateLimit.limitTokens ?? 'unknown'} tokens/min), pausing ${Math.ceil(seconds)}s`);
}

// Summarizes the already-redacted transcript, so the summary never sees PII.
async function summarize(utterances) {
  if (Date.now() < rateLimit.pausedUntil) throw new RateLimitedError();
  let transcript = utterances.map(u => `Speaker ${u.speaker}: ${u.text}`).join('\n');
  // Cap to the model's context and, once known, to 80% of the per-minute budget,
  // so one long call can't exceed the whole limit and fail forever.
  let maxChars = MAX_SUMMARY_TRANSCRIPT_CHARS;
  if (rateLimit.limitTokens) {
    maxChars = Math.min(maxChars, Math.max(0, (Math.floor(rateLimit.limitTokens * 0.8) - estimateTokens(SUMMARY_PROMPT)) * 4));
  }
  if (transcript.length > maxChars) {
    transcript = `${transcript.slice(0, maxChars)}\n[transcript truncated]`;
  }
  const content = `${SUMMARY_PROMPT}\n\nTranscript:\n${transcript}`;
  if (rateLimit.remainingTokens != null && Date.now() < rateLimit.resetAt
      && rateLimit.remainingTokens < estimateTokens(content)) {
    // Not enough budget left in this window: wait for it to reset.
    pauseSummaries((rateLimit.resetAt - Date.now()) / 1000, 'near token limit');
    throw new RateLimitedError();
  }
  let response;
  try {
    response = await axios.post(LLM_GATEWAY_URL, {
      model: SUMMARY_MODEL,
      messages: [{ role: 'user', content }],
      max_tokens: SUMMARY_MAX_TOKENS
    }, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err.response?.status === 429) {
      readRateHeaders(err.response.headers);
      const retryAfter = parseFloat(err.response.headers?.['retry-after']);
      pauseSummaries(isNaN(retryAfter) ? 60 : retryAfter, 'rate limited');
      throw new RateLimitedError();
    }
    throw err;
  }
  const { data } = response;
  readRateHeaders(response.headers);
  console.log(`📝 [TRANSCRIBE] Summary generated request_id=${data.request_id}`);
  // Drop any reasoning block the model emits before its answer.
  return data.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function pollPending() {
  let completed = 0;
  const pending = await getPendingTranscriptions();
  console.log(`📝 [TRANSCRIBE] Tick start: pending=${pending.length}`);
  for (const row of pending) {
    try {
      const { data } = await axios.get(`${API_BASE}/transcript/${row.assemblyai_id}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (data.status === 'error') {
        await upsertTranscription(row.file_path, { status: 'error', error: data.error });
        console.error(`❌ [TRANSCRIBE] AssemblyAI failed ${row.file_path} id=${row.assemblyai_id}:`, data.error);
        continue;
      }
      if (data.status !== 'completed') continue;
      const utterances = (data.utterances || []).map(({ speaker, start, end, text }) => ({ speaker, start, end, text }));
      let summary = null;
      let error = null;
      try {
        summary = utterances.length ? await summarize(utterances) : null;
      } catch (err) {
        // Keep the transcript; a failed summary must not leave the row stuck in 'processing'.
        // Rate-limited ones are picked up later by retryMissingSummaries.
        error = err instanceof RateLimitedError ? RATE_LIMITED_ERROR : `Summary failed: ${apiError(err)}`;
        if (!(err instanceof RateLimitedError)) console.error(`❌ [TRANSCRIBE] ${error} (${row.file_path})`);
      }
      await upsertTranscription(row.file_path, { status: 'completed', transcriptText: data.text, utterances, summary, error });
      console.log(`📝 [TRANSCRIBE] Completed ${row.file_path} id=${row.assemblyai_id} summary=${summary ? 'yes' : 'no'}`);
      completed++;
    } catch (err) {
      console.error(`❌ [TRANSCRIBE] Poll failed for ${row.file_path}:`, apiError(err));
    }
  }
  return completed;
}

// Re-summarizes stored (redacted) transcripts whose summary failed, without transcribing again.
async function retryMissingSummaries() {
  let fixed = 0;
  for (const row of await getTranscriptionsMissingSummary(MAX_SUBMISSIONS_PER_TICK)) {
    if (Date.now() < rateLimit.pausedUntil) break; // leave the rest as-is until the window resets
    try {
      await updateTranscriptionSummary(row.file_path, await summarize(row.utterances), null);
      fixed++;
    } catch (err) {
      if (err instanceof RateLimitedError) break;
      const error = `Summary failed: ${apiError(err)}`;
      await updateTranscriptionSummary(row.file_path, null, error);
      console.error(`❌ [TRANSCRIBE] ${error} (${row.file_path})`);
    }
  }
  return fixed;
}

async function submitNew(s3, bucket) {
  const cutoff = dayjs().tz(TIMEZONE).subtract(LOOKBACK_DAYS, 'day').format('YYYY-MM-DD');
  const filePaths = await getFilesNeedingTranscription(cutoff, MIN_DURATION_SECONDS * 1000, MAX_SUBMISSIONS_PER_TICK);
  let submitted = 0;
  for (const filePath of filePaths) {
    try {
      const assemblyaiId = await submitRecording(s3, bucket, filePath);
      await upsertTranscription(filePath, { assemblyaiId, status: 'processing' });
      console.log(`📝 [TRANSCRIBE] Submitted ${filePath} id=${assemblyaiId}`);
      submitted++;
    } catch (err) {
      // Not retried automatically, to avoid repeat charges; delete the row to retry.
      await upsertTranscription(filePath, { status: 'error', error: apiError(err) });
      console.error(`❌ [TRANSCRIBE] Submit failed for ${filePath}:`, apiError(err));
    }
  }
  return { submitted, failed: filePaths.length - submitted };
}

export function startTranscriptionWorker({ s3, bucket }) {
  if (!API_KEY) {
    console.log('📝 [TRANSCRIBE] ASSEMBLYAI_API_KEY not set; transcription disabled');
    return;
  }
  console.log(`📝 [TRANSCRIBE] Worker started: lookback=${LOOKBACK_DAYS}d minDuration>${MIN_DURATION_SECONDS}s piiPolicies=${PII_POLICIES.length} summaryModel=${SUMMARY_MODEL}`);
  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    let client;
    let locked = false;
    try {
      // Every container runs this worker. The lock stops two of them submitting
      // the same recording; it's freed automatically if this connection dies.
      client = await pool.connect();
      ({ rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [TRANSCRIBE_LOCK_KEY]));
      if (!locked) return;
      const completed = await pollPending();
      const summariesRetried = await retryMissingSummaries();
      const { submitted, failed } = await submitNew(s3, bucket);
      console.log(`📝 [TRANSCRIBE] completed=${completed} summariesRetried=${summariesRetried} submitted=${submitted} failed=${failed}`);
    } catch (err) {
      console.error('❌ [TRANSCRIBE] Tick failed:', err.message);
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [TRANSCRIBE_LOCK_KEY]).catch(() => {});
      client?.release();
      isRunning = false;
    }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, INTERVAL_MS);
}
