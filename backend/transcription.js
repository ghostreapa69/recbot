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
  pool, getFilesNeedingTranscription, getJobsInScriberr, countJobsInScriberr, getTranscriptsToRedact, markTranscribed,
  upsertTranscription, markRedactionFailed,
  getTranscriptionsNeedingAnalysis, saveCallAnalysis, saveCallAnalysisError, saveCallAnalysisRetry,
  getAnalysesNeedingSpeakerCheck, markSpeakerChecked, deleteCallAnalysis, adoptScriberrJob, resetTranscription, requeueFailedAnalyses
} from './database.js';
import * as scriberr from './scriberr.js';
import { redactUtterances, analyzeCall, identifyAgentSpeaker } from './analysis.js';
import { claudeConfigured, createClaudeLlm, CLAUDE_SCORING_MODEL } from './claude.js';
import { trackJob } from './activity.js';

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
// Batch size for each redaction / scoring / speaker re-check pass.
const MAX_PER_TICK = parseInt(process.env.TRANSCRIBE_MAX_PER_TICK || '10', 10);
// Scriberr's in-memory queue holds 200 waiting jobs; past that, submits fail with
// "Failed to enqueue job" and the job is stranded. The feeder keeps this many jobs in
// Scriberr (queued or running) so it always has work.
const MAX_QUEUED = parseInt(process.env.SCRIBERR_MAX_QUEUED || '50', 10);
const MAX_REDACTION_ATTEMPTS = 3;
const TIMEZONE = process.env.FIVE9_TIMEZONE || 'America/Los_Angeles';

// The feeder tops Scriberr up this often; the processor waits this long when it has nothing to do.
const FEED_INTERVAL_MS = 60 * 1000;
const IDLE_WAIT_MS = 60 * 1000;
// Postgres advisory locks: one container processes and one submits at a time.
const PROCESS_LOCK_KEY = 727001;
const FEED_LOCK_KEY = 727004;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const llm = scriberrId => prompt => scriberr.llm(prompt, scriberrId);

// Scoring and the speaker check use Claude (claude.js, structured outputs) when ANTHROPIC_API_KEY
// is set; redaction then goes to Claude too, through scriberr.llm().
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

// Submits recordings until Scriberr holds MAX_QUEUED jobs. Only 'processing' rows count:
// jobs Scriberr finished wait for redaction as 'transcribed' and don't hold up new work.
async function submitNew(s3, bucket) {
  const inFlight = await countJobsInScriberr();
  const room = MAX_QUEUED - inFlight;
  if (room <= 0) return { submitted: 0, failed: 0, inFlight, eligible: null };
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
  return { submitted, failed: filePaths.length - submitted, inFlight, eligible: filePaths.length };
}

// Checks every job still in Scriberr (run by the feeder). Finished ones become 'transcribed'
// (waiting for redaction); missing or restart-interrupted ones are recovered as before.
async function checkJobs() {
  let checked = 0;
  let finished = 0;
  for (const row of await getJobsInScriberr()) {
    checked++;
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
      if (job.status === 'completed') {
        await markTranscribed(row.file_path, id);
        finished++;
      }
    } catch (err) {
      console.error(`❌ [TRANSCRIBE] Status check failed for ${row.file_path}:`, err.message);
    }
  }
  return { checked, finished };
}

// Fetches finished transcripts, redacts them, and only then stores them. The unredacted
// text lives in memory for this function call only and is never written to the database.
async function redactFinished() {
  let completed = 0;
  for (const row of await getTranscriptsToRedact(MAX_PER_TICK)) {
    const id = row.scriberr_id;
    try {
      let raw;
      try {
        raw = await scriberr.transcript(id);
      } catch (err) {
        if (!err.notFound) throw err;
        await resetTranscription(row.file_path);
        console.log(`🔁 [TRANSCRIBE] ${row.file_path}: job ${id} not found when fetching the transcript; resubmitting`);
        continue;
      }
      if (!raw.length) {
        await upsertTranscription(row.file_path, { status: 'completed', transcriptText: '', utterances: [] });
        completed++;
        continue;
      }
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
      console.error(`❌ [TRANSCRIBE] Redaction step failed for ${row.file_path}:`, err.message);
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

// Scoring used to give up on replies whose scores it couldn't find; retry those once per start.
const REQUEUE_ERROR = 'Analysis failed: Analysis has no "scores" object';
let requeueDone = false;

// Runs fn while holding a Postgres advisory lock (every container runs the worker; the
// lock is freed automatically if this connection dies). Returns null if another has it.
async function withLock(key, fn) {
  const client = await pool.connect();
  let locked = false;
  try {
    ({ rows: [{ locked }] } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]));
    return locked ? await fn() : null;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    client.release();
  }
}

// Processor pass: redact finished transcripts, score, re-check speakers.
// Returns true when it did any work, so the next pass can start straight away.
export async function runProcessorPass() {
  const result = await withLock(PROCESS_LOCK_KEY, async () => {
    if (!requeueDone) {
      const requeued = await requeueFailedAnalyses(REQUEUE_ERROR);
      requeueDone = true;
      if (requeued) console.log(`🔁 [ANALYZE] Re-queued ${requeued} call(s) that failed with "no scores"`);
    }
    const redacted = await redactFinished();
    const analyzed = await analyzeMissing();
    const rescored = await recheckSpeakers();
    const worked = redacted + analyzed + rescored > 0;
    if (worked) console.log(`📝 [TRANSCRIBE] redacted ${redacted}, analyzed ${analyzed}, speakerRescores ${rescored}`);
    return worked;
  });
  return Boolean(result);
}

// Feeder pass: mark the jobs Scriberr finished (quick status requests, no LLM), then top it
// back up to MAX_QUEUED, so finished jobs never hold up new work while analysis is busy.
let lastIdleLog = 0;
export async function runFeederPass({ s3, bucket }) {
  return withLock(FEED_LOCK_KEY, async () => {
    const { checked, finished } = await checkJobs();
    const { submitted, failed, inFlight, eligible } = await submitNew(s3, bucket);
    if (submitted || failed || finished) {
      console.log(`📤 [TRANSCRIBE] ${finished} of ${checked} jobs finished; submitted ${submitted}${failed ? `, ${failed} failed` : ''} (Scriberr had ${inFlight} in flight, max ${MAX_QUEUED})`);
    }
    // Room in Scriberr but nothing eligible to send: say so now and then, so idle time is explained.
    if (eligible === 0 && Date.now() - lastIdleLog > 10 * 60 * 1000) {
      lastIdleLog = Date.now();
      console.log(`📭 [TRANSCRIBE] Scriberr has ${inFlight} jobs; no more recordings waiting (last ${LOOKBACK_DAYS} days, over ${MIN_DURATION_SECONDS}s, not a skipped disposition)`);
    }
    return { checked, finished, submitted, failed, inFlight };
  });
}

export function startTranscriptionWorker({ s3, bucket }) {
  if (!scriberr.scriberrConfigured) {
    console.log('📝 [TRANSCRIBE] SCRIBERR_URL not set; transcription disabled');
    return;
  }
  console.log(`📝 [TRANSCRIBE] Worker started: lookback=${LOOKBACK_DAYS}d minDuration>${MIN_DURATION_SECONDS}s batch=${MAX_PER_TICK} scriberrQueue=${MAX_QUEUED} redactionLlm=${scriberr.scriberrLlmModel || '(Scriberr default)'} scoring=${claudeConfigured ? `Claude ${CLAUDE_SCORING_MODEL}` : 'local Scriberr LLM'}`);

  let feeding = false;
  const feed = async () => {
    if (feeding) return;
    feeding = true;
    try {
      await trackJob('transcription-feed', () => runFeederPass({ s3, bucket }));
    } catch (err) {
      console.error('❌ [TRANSCRIBE] Feeder failed:', err.message);
    } finally {
      feeding = false;
    }
  };
  // Back to back while there is work; a pause when there isn't (or another container has the lock).
  const processLoop = async () => {
    let worked = false;
    try {
      worked = await trackJob('transcription-process', runProcessorPass);
    } catch (err) {
      console.error('❌ [TRANSCRIBE] Processor failed:', err.message);
    } finally {
      setTimeout(processLoop, worked ? 1000 : IDLE_WAIT_MS);
    }
  };
  setTimeout(() => { feed(); setInterval(feed, FEED_INTERVAL_MS); }, 60 * 1000);
  setTimeout(processLoop, 60 * 1000);
}
