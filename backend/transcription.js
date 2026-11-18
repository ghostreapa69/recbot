import dayjs from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  pool, getFilesNeedingTranscription, getPendingTranscriptions, upsertTranscription, markRedactionFailed,
  getTranscriptionsNeedingAnalysis, saveCallAnalysis, saveCallAnalysisError,
  getAnalysesNeedingSpeakerCheck, markSpeakerChecked, deleteCallAnalysis
} from './database.js';
import * as scriberr from './scriberr.js';
import { redactUtterances, analyzeCall, identifyAgentSpeaker } from './analysis.js';

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

const LOOKBACK_DAYS = parseInt(process.env.TRANSCRIBE_LOOKBACK_DAYS || '7', 10);
const MIN_DURATION_SECONDS = parseInt(process.env.TRANSCRIBE_MIN_DURATION_SECONDS || '50', 10);
// On-prem GPU capacity sets the pace, so each step's batch size is configurable.
const MAX_PER_TICK = parseInt(process.env.TRANSCRIBE_MAX_PER_TICK || '10', 10);
const MAX_REDACTION_ATTEMPTS = 3;
const TIMEZONE = process.env.FIVE9_TIMEZONE || 'America/Los_Angeles';

const INTERVAL_MS = 5 * 60 * 1000;
// Postgres advisory lock key: only one container runs a tick at a time.
const TRANSCRIBE_LOCK_KEY = 727001;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const llm = scriberrId => prompt => scriberr.llm(prompt, scriberrId);

// Telephony formats vary, so every recording goes to Scriberr as 16 kHz mono WAV.
async function downloadAsWav(s3, bucket, filePath) {
  const key = filePath.startsWith('recordings/') ? filePath : `recordings/${filePath}`;
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  const outPath = path.join(os.tmpdir(), `scriberr-${crypto.randomUUID()}.wav`);
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0',
      '-fflags', '+discardcorrupt', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', '-y', outPath],
    { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => {
      if (!object.Body.readableEnded) object.Body.destroy(); // frees the S3 connection if ffmpeg stopped early
      if (code === 0) resolve(); else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
    object.Body.on('error', err => ffmpeg.stdin.destroy(err));
    ffmpeg.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input; the close code reports it
    object.Body.pipe(ffmpeg.stdin);
  });
  return outPath;
}

async function submitNew(s3, bucket) {
  const cutoff = dayjs().tz(TIMEZONE).subtract(LOOKBACK_DAYS, 'day').format('YYYY-MM-DD');
  const filePaths = await getFilesNeedingTranscription(cutoff, MIN_DURATION_SECONDS * 1000, MAX_PER_TICK);
  let submitted = 0;
  for (const filePath of filePaths) {
    let wavPath;
    try {
      wavPath = await downloadAsWav(s3, bucket, filePath);
      const scriberrId = await scriberr.submit(wavPath, filePath.split('/').pop());
      await upsertTranscription(filePath, { scriberrId, status: 'processing' });
      console.log(`📝 [TRANSCRIBE] Submitted ${filePath} id=${scriberrId}`);
      submitted++;
    } catch (err) {
      // Not retried automatically; delete the row to retry.
      await upsertTranscription(filePath, { status: 'error', error: `Submit failed: ${err.message}` });
      console.error(`❌ [TRANSCRIBE] Submit failed for ${filePath}:`, err.message);
    } finally {
      if (wavPath) fs.promises.unlink(wavPath).catch(() => {});
    }
  }
  return { submitted, failed: filePaths.length - submitted };
}

// Finished jobs are fetched, redacted, and only then stored. The unredacted text
// lives in memory for this function call only and is never written to the database.
async function pollPending() {
  let completed = 0;
  let redacted = 0;
  const pending = await getPendingTranscriptions();
  console.log(`📝 [TRANSCRIBE] Tick start: pending=${pending.length}`);
  for (const row of pending) {
    if (redacted >= MAX_PER_TICK) break; // redaction is the slow step; leave the rest for the next tick
    try {
      const job = await scriberr.status(row.scriberr_id);
      if (job.status === 'failed') {
        await upsertTranscription(row.file_path, { status: 'error', error: job.error || 'Scriberr reported the job failed' });
        console.error(`❌ [TRANSCRIBE] Scriberr failed ${row.file_path} id=${row.scriberr_id}: ${job.error || ''}`);
        continue;
      }
      if (job.status !== 'completed') continue;

      const raw = await scriberr.transcript(row.scriberr_id);
      if (!raw.length) {
        await upsertTranscription(row.file_path, { status: 'completed', transcriptText: '', utterances: [] });
        completed++;
        continue;
      }
      redacted++;
      let utterances;
      try {
        utterances = await redactUtterances(raw, llm(row.scriberr_id));
      } catch (err) {
        const attempts = await markRedactionFailed(row.file_path, `Redaction failed: ${err.message}`, MAX_REDACTION_ATTEMPTS);
        console.error(`❌ [TRANSCRIBE] Redaction failed for ${row.file_path} (attempt ${attempts}/${MAX_REDACTION_ATTEMPTS}): ${err.message}`);
        continue;
      }
      await upsertTranscription(row.file_path, {
        status: 'completed',
        transcriptText: utterances.map(u => u.text).join(' '),
        utterances
      });
      console.log(`📝 [TRANSCRIBE] Completed ${row.file_path} id=${row.scriberr_id} lines=${utterances.length}`);
      completed++;
    } catch (err) {
      console.error(`❌ [TRANSCRIBE] Poll failed for ${row.file_path}:`, err.message);
    }
  }
  return completed;
}

// Scores completed transcripts that have no analysis yet. This also backfills
// transcripts made before the switch to Scriberr.
async function analyzeMissing() {
  let analyzed = 0;
  for (const row of await getTranscriptionsNeedingAnalysis(MAX_PER_TICK)) {
    try {
      const result = await analyzeCall(row.utterances, llm(row.scriberr_id));
      await saveCallAnalysis(row.file_path, result, scriberr.scriberrLlmModel || null);
      console.log(`📊 [ANALYZE] ${row.file_path} overall=${result.overall}`);
      analyzed++;
    } catch (err) {
      await saveCallAnalysisError(row.file_path, `Analysis failed: ${err.message}`, scriberr.scriberrLlmModel || null);
      console.error(`❌ [ANALYZE] Failed for ${row.file_path}: ${err.message}`);
    }
  }
  return analyzed;
}

// Re-checks scorecards made before the speaker check existed. If the agent turns out to be
// the other speaker, the scorecard is deleted so the next tick scores the call again.
export async function recheckSpeakers(limit = MAX_PER_TICK) {
  let rescored = 0;
  for (const row of await getAnalysesNeedingSpeakerCheck(limit)) {
    try {
      const detected = await identifyAgentSpeaker(row.utterances, llm(row.scriberr_id));
      if (detected && row.agent_speaker && detected !== row.agent_speaker) {
        console.log(`🔁 [SPEAKER] ${row.file_path} agent was ${row.agent_speaker}, detected ${detected} — rescoring`);
        await deleteCallAnalysis(row.file_path);
        rescored++;
      } else {
        await markSpeakerChecked(row.file_path);
      }
    } catch (err) {
      // Left unchecked, so it's tried again on a later tick.
      console.error(`❌ [SPEAKER] Check failed for ${row.file_path}: ${err.message}`);
    }
  }
  return rescored;
}

let isRunning = false;

// One pass of the worker: poll finished jobs, score new transcripts, submit new recordings.
export async function runTranscriptionTick({ s3, bucket }) {
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
    const analyzed = await analyzeMissing();
    const rescored = await recheckSpeakers();
    const { submitted, failed } = await submitNew(s3, bucket);
    console.log(`📝 [TRANSCRIBE] completed=${completed} analyzed=${analyzed} speakerRescores=${rescored} submitted=${submitted} failed=${failed}`);
  } catch (err) {
    console.error('❌ [TRANSCRIBE] Tick failed:', err.message);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [TRANSCRIBE_LOCK_KEY]).catch(() => {});
    client?.release();
    isRunning = false;
  }
}

export function startTranscriptionWorker({ s3, bucket }) {
  if (!scriberr.scriberrConfigured) {
    console.log('📝 [TRANSCRIBE] SCRIBERR_URL not set; transcription disabled');
    return;
  }
  console.log(`📝 [TRANSCRIBE] Worker started: lookback=${LOOKBACK_DAYS}d minDuration>${MIN_DURATION_SECONDS}s maxPerTick=${MAX_PER_TICK} llmModel=${scriberr.scriberrLlmModel || '(Scriberr default)'}`);
  const tick = () => runTranscriptionTick({ s3, bucket });
  setTimeout(tick, 60 * 1000);
  setInterval(tick, INTERVAL_MS);
}
