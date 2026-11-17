import axios from 'axios';
import dayjs from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getFilesNeedingTranscription, getPendingTranscriptions, upsertTranscription } from './database.js';

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
const SUMMARY_MODEL = 'claude-haiku-5-5';
const API_BASE = 'https://api.assemblyai.com/v2';
const LLM_GATEWAY_URL = 'https://llm-gateway.assemblyai.com/v1/chat/completions';

const SUMMARY_PROMPT = `Summarize this mortgage company phone call in 3-6 short bullet points: the purpose of the call, key details discussed, the outcome, and any next steps. Speakers are labelled by diarization (e.g. "Speaker A") and may be the agent or the customer. Some information has been redacted and appears as placeholders like [PHONE_NUMBER]; keep those placeholders as-is and never guess what they contain. Reply with only the bullet points.`;

const headers = { authorization: API_KEY };

function apiError(err) {
  return err.response?.data?.error || err.message;
}

async function submitRecording(s3, bucket, filePath) {
  const key = filePath.startsWith('recordings/') ? filePath : `recordings/${filePath}`;
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const upload = await axios.post(`${API_BASE}/upload`, object.Body, {
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      ...(object.ContentLength && { 'content-length': object.ContentLength })
    },
    maxBodyLength: Infinity
  });
  const { data } = await axios.post(`${API_BASE}/transcript`, {
    audio_url: upload.data.upload_url,
    speaker_labels: true, // recordings are mono, so diarization separates agent and customer
    redact_pii: true,
    redact_pii_policies: PII_POLICIES,
    redact_pii_sub: 'entity_name'
  }, { headers });
  return data.id;
}

// Summarizes the already-redacted transcript, so the summary never sees PII.
async function summarize(utterances) {
  const transcript = utterances.map(u => `Speaker ${u.speaker}: ${u.text}`).join('\n');
  const { data } = await axios.post(LLM_GATEWAY_URL, {
    model: SUMMARY_MODEL,
    messages: [{ role: 'user', content: `${SUMMARY_PROMPT}\n\nTranscript:\n${transcript}` }],
    max_tokens: 1000
  }, { headers });
  console.log(`📝 [TRANSCRIBE] Summary generated request_id=${data.request_id}`);
  return data.choices[0].message.content.trim();
}

async function pollPending() {
  let completed = 0;
  for (const row of await getPendingTranscriptions()) {
    try {
      const { data } = await axios.get(`${API_BASE}/transcript/${row.assemblyai_id}`, { headers });
      if (data.status === 'error') {
        await upsertTranscription(row.file_path, { status: 'error', error: data.error });
        continue;
      }
      if (data.status !== 'completed') continue;
      const utterances = (data.utterances || []).map(({ speaker, start, end, text }) => ({ speaker, start, end, text }));
      try {
        const summary = utterances.length ? await summarize(utterances) : null;
        await upsertTranscription(row.file_path, { status: 'completed', transcriptText: data.text, utterances, summary });
        completed++;
      } catch (err) {
        // Stay 'processing' so the summary is retried next tick.
        await upsertTranscription(row.file_path, { status: 'processing', error: `Summary failed: ${apiError(err)}` });
      }
    } catch (err) {
      console.error(`❌ [TRANSCRIBE] Poll failed for ${row.file_path}:`, apiError(err));
    }
  }
  return completed;
}

async function submitNew(s3, bucket) {
  const cutoff = dayjs().tz(TIMEZONE).subtract(LOOKBACK_DAYS, 'day').format('YYYY-MM-DD');
  const filePaths = await getFilesNeedingTranscription(cutoff, MIN_DURATION_SECONDS * 1000, MAX_SUBMISSIONS_PER_TICK);
  let submitted = 0;
  for (const filePath of filePaths) {
    try {
      const assemblyaiId = await submitRecording(s3, bucket, filePath);
      await upsertTranscription(filePath, { assemblyaiId, status: 'processing' });
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
  console.log(`📝 [TRANSCRIBE] Worker started: lookback=${LOOKBACK_DAYS}d minDuration>${MIN_DURATION_SECONDS}s piiPolicies=${PII_POLICIES.length}`);
  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const completed = await pollPending();
      const { submitted, failed } = await submitNew(s3, bucket);
      console.log(`📝 [TRANSCRIBE] completed=${completed} submitted=${submitted} failed=${failed}`);
    } catch (err) {
      console.error('❌ [TRANSCRIBE] Tick failed:', err.message);
    } finally {
      isRunning = false;
    }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, INTERVAL_MS);
}
