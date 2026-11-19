// The only module that talks to the self-hosted Scriberr server.
// Endpoints follow Scriberr's swagger (v1.2.0). The transcript shape and its
// time units are not documented there, so normalizeTranscript() accepts the
// common WhisperX-style shapes and converts everything to ms utterances.
import fs from 'fs';
import path from 'path';

const BASE_URL = (process.env.SCRIBERR_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.SCRIBERR_API_KEY || '';
const TRANSCRIBE_MODEL = process.env.SCRIBERR_TRANSCRIBE_MODEL || '';
// Scriberr runs submitted jobs on the CPU unless told otherwise; set 'cuda' for a GPU server.
const DEVICE = process.env.SCRIBERR_DEVICE || '';
const COMPUTE_TYPE = process.env.SCRIBERR_COMPUTE_TYPE || '';
const BATCH_SIZE = process.env.SCRIBERR_BATCH_SIZE || '';
const LANGUAGE = process.env.SCRIBERR_LANGUAGE || 'en';
const LLM_MODEL = process.env.SCRIBERR_LLM_MODEL || '';
const REQUEST_TIMEOUT_MS = 30 * 1000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
// Local LLMs on modest GPUs can take minutes for a long transcript.
const LLM_TIMEOUT_MS = parseInt(process.env.SCRIBERR_LLM_TIMEOUT_MS || String(10 * 60 * 1000), 10);
// With an Anthropic API key set, LLM prompts go straight to the Claude API instead of
// through Scriberr's /summarize (which sends no max_tokens and only reaches Claude via
// the OpenAI-compatibility layer).
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const ANTHROPIC_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS || '16000', 10);

export const scriberrConfigured = Boolean(BASE_URL);
export const scriberrLlmModel = ANTHROPIC_API_KEY ? ANTHROPIC_MODEL : LLM_MODEL;

export class ScriberrError extends Error {}

async function request(urlPath, { method = 'GET', body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    body,
    headers: { 'X-API-Key': API_KEY, ...headers },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json.error || json.message || text;
    } catch {}
    const err = new ScriberrError(`HTTP ${res.status} ${method} ${urlPath}: ${String(message).slice(0, 300)}`);
    err.notFound = res.status === 404;
    throw err;
  }
  return res;
}

// Submits a local audio file for transcription with two-speaker diarization; returns the job id.
export async function submit(filePath, title) {
  const form = new FormData();
  form.append('audio', await fs.openAsBlob(filePath, { type: 'audio/wav' }), path.basename(filePath));
  form.append('title', title);
  form.append('diarization', 'true');
  form.append('min_speakers', '2');
  form.append('max_speakers', '2');
  form.append('language', LANGUAGE);
  if (TRANSCRIBE_MODEL) form.append('model', TRANSCRIBE_MODEL);
  if (DEVICE) form.append('device', DEVICE);
  if (COMPUTE_TYPE) form.append('compute_type', COMPUTE_TYPE);
  if (BATCH_SIZE) form.append('batch_size', BATCH_SIZE);
  const res = await request('/api/v1/transcription/submit', { method: 'POST', body: form, timeoutMs: UPLOAD_TIMEOUT_MS });
  const job = await res.json();
  const id = job.id ?? job.job_id ?? job.ID;
  if (id === undefined || id === null) throw new ScriberrError(`Submit returned no job id: ${JSON.stringify(job).slice(0, 300)}`);
  return String(id);
}

// Returns { status: 'uploaded'|'pending'|'processing'|'completed'|'failed', error }.
export async function status(id) {
  const res = await request(`/api/v1/transcription/${encodeURIComponent(id)}/status`);
  const job = await res.json();
  return { status: String(job.status || '').toLowerCase(), error: job.error_message || job.error || null };
}

// Jobs submitted with exactly this title (RecBot uses the recording's file name), newest first.
// Scriberr's search is a LIKE match where "_" is a wildcard, so titles are compared exactly here.
export async function findJobsByTitle(title) {
  const qs = new URLSearchParams({ q: title, limit: '20', page: '1', sort_by: 'created_at', sort_order: 'desc' });
  const res = await request(`/api/v1/transcription/list?${qs}`);
  const body = await res.json();
  return (Array.isArray(body?.jobs) ? body.jobs : [])
    .filter(j => j && j.title === title && j.id && !j.deleted_at)
    .map(j => ({ id: String(j.id), status: String(j.status || '').toLowerCase(), error: j.error_message || null }));
}

export async function transcript(id) {
  const res = await request(`/api/v1/transcription/${encodeURIComponent(id)}/transcript`);
  return normalizeTranscript(await res.json());
}

function findSegments(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    try { return findSegments(JSON.parse(data)); } catch { return null; }
  }
  if (Array.isArray(data)) return data;
  for (const key of ['segments', 'utterances']) {
    if (Array.isArray(data[key])) return data[key];
  }
  for (const key of ['transcript', 'result', 'data']) {
    const nested = findSegments(data[key]);
    if (nested) return nested;
  }
  return null;
}

// Converts Scriberr's transcript into [{ speaker: 'A'|'B'|..., start, end, text }] in ms,
// merging consecutive segments from the same speaker. Times are treated as seconds when
// any value is fractional or the call would otherwise be under 20 seconds long.
export function normalizeTranscript(data) {
  const segments = (findSegments(data) || [])
    .map(s => ({
      speaker: s.speaker ?? s.speaker_label ?? s.speakerLabel ?? 'unknown',
      start: Number(s.start ?? s.start_time ?? 0),
      end: Number(s.end ?? s.end_time ?? s.start ?? 0),
      text: String(s.text ?? '').trim()
    }))
    .filter(s => s.text && Number.isFinite(s.start) && Number.isFinite(s.end));
  if (!segments.length) return [];

  const times = segments.flatMap(s => [s.start, s.end]);
  const inSeconds = times.some(t => !Number.isInteger(t)) || Math.max(...times) < 20000;
  const toMs = t => Math.round(inSeconds ? t * 1000 : t);

  // Map raw labels (e.g. SPEAKER_00) to letters in order of first appearance, as AssemblyAI did.
  const letters = new Map();
  const letterFor = label => {
    if (!letters.has(label)) letters.set(label, String.fromCharCode(65 + letters.size));
    return letters.get(label);
  };

  const utterances = [];
  for (const s of segments.sort((a, b) => a.start - b.start)) {
    const speaker = letterFor(String(s.speaker));
    const last = utterances[utterances.length - 1];
    if (last && last.speaker === speaker) {
      last.end = Math.max(last.end, toMs(s.end));
      last.text = `${last.text} ${s.text}`;
    } else {
      utterances.push({ speaker, start: toMs(s.start), end: toMs(s.end), text: s.text });
    }
  }
  return utterances;
}

// Reads an SSE (or plain) body into the full text the model produced.
export function parseLlmBody(raw) {
  if (!/^\s*(data|event|id):/m.test(raw)) {
    try {
      const json = JSON.parse(raw);
      return pickText(json) ?? raw;
    } catch {
      return raw;
    }
  }
  let out = '';
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).replace(/^ /, '');
    if (payload.trim() === '[DONE]') break;
    try {
      const json = JSON.parse(payload);
      const text = pickText(json);
      if (text !== null && text !== undefined) out += text;
      continue;
    } catch {}
    // An empty data line inside one SSE event stands for a newline in the text.
    out += payload === '' ? '\n' : payload;
  }
  return out;
}

function pickText(json) {
  if (typeof json === 'string') return json;
  if (!json || typeof json !== 'object') return null;
  const choice = json.choices?.[0];
  return choice?.delta?.content ?? choice?.message?.content ?? json.content ?? json.text ?? json.delta ?? json.chunk ?? json.summary ?? json.response ?? null;
}

// Runs one prompt through the LLM configured in Scriberr. The prompt is sent as the
// content to summarize, tied to the job it is about.
export async function llm(prompt, transcriptionId) {
  if (ANTHROPIC_API_KEY) return claude(prompt);
  const res = await request('/api/v1/summarize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ transcription_id: transcriptionId ? String(transcriptionId) : '', content: prompt, model: LLM_MODEL }),
    timeoutMs: LLM_TIMEOUT_MS
  });
  const text = parseLlmBody(await res.text());
  // Drop any reasoning block the model emits before its answer.
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// One prompt through the Claude Messages API. Rate-limit and overload responses are
// retried a few times, honoring retry-after.
async function claude(prompt) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: ANTHROPIC_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = parseFloat(res.headers.get('retry-after')) || 5 * attempt;
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${json.error?.message || 'no details'}`);
    if (json.stop_reason === 'max_tokens') throw new Error(`Claude reply cut off at ${ANTHROPIC_MAX_TOKENS} tokens`);
    return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }
}
