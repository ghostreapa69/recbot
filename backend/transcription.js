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
  getTranscriptionsNeedingAnalysis, saveCallAnalysis, saveCallAnalysisError, saveCallAnalysisRetry,
  getAnalysesNeedingSpeakerCheck, markSpeakerChecked, deleteCallAnalysis, adoptScriberrJob, resetTranscription, requeueFailedAnalyses
} from './database.js';
import * as scriberr from './scriberr.js';
import { redactUtterances, analyzeCall, identifyAgentSpeaker } from './analysis.js';
import { claudeConfigured, createClaudeLlm, CLAUDE_SCORING_MODEL } from './claude.js';

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

const LOOKBACK_DAYS = parseInt(process.env.TRANSCRIBE_LOOKBACK_DAYS || '7', 10);
const MIN_DURATION_SECONDS = parseInt(process.env.TRANSCRIBE_MIN_DURATION_SECONDS || '50', 10);
// Calls at or below this length are never transcribed or scored.
export const MIN_DURATION_MS = MIN_DURATION_SECONDS * 1000;
// Calls with these dispositions are never transcribed or scored (matched case-insensitively).
export const SKIP_DISPOSITIONS = [
  'Agent Error', 'Answering Machine', 'DeadAir', 'Force Stop', 'Forced Logout',
  'Recycle', 'Sent To Voicemail', 'System Shutdown', 'Voicemail', 'X - DO NOT USE - ACW Expired'
];
// On-prem GPU capacity sets the pace, so each step's batch size is configurable.
const MAX_PER_TICK = parseInt(process.env.TRANSCRIBE_MAX_PER_TICK || '10', 10);
// Scriberr's in-memory queue holds 200 waiting jobs; past that, submits fail with
// "Failed to enqueue job" and the job is stranded. Keep our in-flight count well under it.
const MAX_QUEUED = parseInt(process.env.SCRIBERR_MAX_QUEUED || '50', 10);
const MAX_REDACTION_ATTEMPTS = 3;
const TIMEZONE = process.env.FIVE9_TIMEZONE || 'America/Los_Angeles';

const INTERVAL_MS = 5 * 60 * 1000;
// Postgres advisory lock key: only one container runs a tick at a time.
const TRANSCRIBE_LOCK_KEY = 727001;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const llm = scriberrId => prompt => scriberr.llm(prompt, scriberrId);

// Scoring and the speaker check use Claude Haiku when ANTHROPIC_API_KEY is set; redaction
// always stays on the local Scriberr LLM (it sees the unredacted text).
const claudeLlm = claudeConfigured ? createClaudeLlm() : null;
const scoringLlm = scriberrId => claudeLlm || llm(scriberrId);
const SCORING_MODEL = claudeConfigured ? CLAUDE_SCORING_MODEL : (scriberr.scriberrLlmModel || null);
const MAX_CLAUDE_ATTEMPTS = 3;

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

const RUNNING = ['processing', 'pending', 'uploaded'];
// Scriberr marks jobs that were running when it restarted as failed with this message.
const INTERRUPTED = /interrupted by server restart/i;

// Another Scriberr job for the same recording (jobs are titled with the file name):
// a completed one first, else one still running. Null if there is none.
async function findExistingJob(filePath) {
  const jobs = await scriberr.findJobsByTitle(filePath.split('/').pop());
  return jobs.find(j => j.status === 'completed') || jobs.find(j => RUNNING.includes(j.status)) || null;
}

async function submitNew(s3, bucket) {
  const { rows: [{ n: inFlight }] } = await pool.query("SELECT count(*)::int AS n FROM transcriptions WHERE status = 'processing'");
  const room = Math.min(MAX_PER_TICK, MAX_QUEUED - inFlight);
  if (room <= 0) {
    console.log(`📝 [TRANSCRIBE] Scriberr has ${inFlight} jobs in flight (max ${MAX_QUEUED}); not submitting this tick`);
    return { submitted: 0, failed: 0 };
  }
  const cutoff = dayjs().tz(TIMEZONE).subtract(LOOKBACK_DAYS, 'day').format('YYYY-MM-DD');
  const filePaths = await getFilesNeedingTranscription(cutoff, MIN_DURATION_MS, room, SKIP_DISPOSITIONS.map(d => d.toLowerCase()));
  let submitted = 0;
  for (const filePath of filePaths) {
    let wavPath;
    try {
      // A redeploy can interrupt a submit after Scriberr already has the job; reuse it instead of uploading again.
      let existing = null;
      try {
        existing = await findExistingJob(filePath);
      } catch (err) {
        console.warn(`⚠️ [TRANSCRIBE] Job lookup failed for ${filePath}, submitting: ${err.message}`);
      }
      if (existing) {
        await upsertTranscription(filePath, { scriberrId: existing.id, status: 'processing' });
        console.log(`🔗 [TRANSCRIBE] ${filePath} already in Scriberr as job ${existing.id} (${existing.status}); not resubmitting`);
        submitted++;
        continue;
      }
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
      let id = row.scriberr_id;
      let job;
      try {
        job = await scriberr.status(id);
      } catch (err) {
        if (!err.notFound) throw err;
        job = { status: 'missing' };
      }
      // The job is gone, or Scriberr restarted mid-job: use another job for this recording if
      // Scriberr has one, otherwise submit the recording again.
      if (job.status === 'missing' || (job.status === 'failed' && INTERRUPTED.test(job.error || ''))) {
        const why = job.status === 'missing' ? `job ${id} not found` : `job ${id} interrupted by a Scriberr restart`;
        const found = await findExistingJob(row.file_path);
        if (!found) {
          await resetTranscription(row.file_path);
          console.log(`🔁 [TRANSCRIBE] ${row.file_path}: ${why} and no other job has this title; resubmitting`);
          continue;
        }
        await adoptScriberrJob(row.file_path, found.id);
        console.log(`🔗 [TRANSCRIBE] ${row.file_path}: ${why}; using job ${found.id} (${found.status})`);
        id = found.id;
        job = found;
      }
      if (job.status === 'failed') {
        await upsertTranscription(row.file_path, { status: 'error', error: job.error || 'Scriberr reported the job failed' });
        console.error(`❌ [TRANSCRIBE] Scriberr failed ${row.file_path} id=${id}: ${job.error || ''}`);
        continue;
      }
      if (job.status !== 'completed') continue;

      const raw = await scriberr.transcript(id);
      if (!raw.length) {
        await upsertTranscription(row.file_path, { status: 'completed', transcriptText: '', utterances: [] });
        completed++;
        continue;
      }
      redacted++;
      let utterances;
      try {
        utterances = await redactUtterances(raw, llm(id));
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
      console.log(`📝 [TRANSCRIBE] Completed ${row.file_path} id=${id} lines=${utterances.length}`);
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
      const result = await analyzeCall(row.utterances, scoringLlm(row.scriberr_id));
      await saveCallAnalysis(row.file_path, result, SCORING_MODEL);
      console.log(`📊 [ANALYZE] ${row.file_path} overall=${result.overall}`);
      analyzed++;
    } catch (err) {
      if (claudeConfigured) {
        // Claude failures (outage, rate limit, refusal) are retried on a later tick.
        const { attempts, status } = await saveCallAnalysisRetry(row.file_path, `Analysis failed: ${err.message}`, SCORING_MODEL, MAX_CLAUDE_ATTEMPTS);
        console.error(`❌ [ANALYZE] Failed for ${row.file_path} (attempt ${attempts}/${MAX_CLAUDE_ATTEMPTS}${status === 'retry' ? ', will retry' : ''}): ${err.message}`);
      } else {
        await saveCallAnalysisError(row.file_path, `Analysis failed: ${err.message}`, SCORING_MODEL);
        console.error(`❌ [ANALYZE] Failed for ${row.file_path}: ${err.message}`);
      }
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
      const detected = await identifyAgentSpeaker(row.utterances, scoringLlm(row.scriberr_id));
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
// Scoring used to give up on replies whose scores it couldn't find; retry those once per start.
const REQUEUE_ERROR = 'Analysis failed: Analysis has no "scores" object';
let requeueDone = false;

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
    if (!requeueDone) {
      const requeued = await requeueFailedAnalyses(REQUEUE_ERROR);
      requeueDone = true;
      if (requeued) console.log(`🔁 [ANALYZE] Re-queued ${requeued} call(s) that failed with "no scores"`);
    }
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
  console.log(`📝 [TRANSCRIBE] Worker started: lookback=${LOOKBACK_DAYS}d minDuration>${MIN_DURATION_SECONDS}s maxPerTick=${MAX_PER_TICK} redactionLlm=${scriberr.scriberrLlmModel || '(Scriberr default)'} scoring=${claudeConfigured ? `Claude ${CLAUDE_SCORING_MODEL}` : 'local Scriberr LLM'}`);
  const tick = () => runTranscriptionTick({ s3, bucket });
  setTimeout(tick, 60 * 1000);
  setInterval(tick, INTERVAL_MS);
}
