// Audio conversion, local disk cache and waveform generation for /api/audio and /api/waveform.
// Built to stay cheap on hour-long calls: nothing reads a whole recording into memory, each
// file is converted once even when several requests ask for it at the same time, and S3
// streams are closed when the browser goes away.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const LOCAL_TTL_MS = parseInt(process.env.AUDIO_LOCAL_CACHE_TTL_MS || String(10 * 60 * 1000), 10);
const WAVEFORM_HZ = 8000;
const WAVEFORM_BLOCK = 80; // samples per 10 ms block at 8 kHz
const WAVEFORM_POINTS = 1000;

export const audioCacheKey = s3Key => 'cache/wav/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.wav';
export const waveformCacheKey = s3Key => 'cache/waveform/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.json';

// Pipe an S3 body to a response; if the browser disconnects first, the S3 stream is destroyed
// so its connection goes back to the pool.
export function pipeToResponse(body, res, label = '') {
  pipeline(body, res, err => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`❌ [STREAM ERR]${label}`, err.message);
  });
}

// "bytes=a-b" -> { start, end } within size, or null if absent/unsatisfiable.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  else { start = parseInt(m[1], 10); end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

// Folds per-block peak and sum-of-squares into the 1,000 points the player draws, with the
// same peak/RMS blend and compression the old in-memory version used.
export class WaveformBuilder {
  constructor() { this.peaks = []; this.sums = []; this.counts = []; this.carry = null; this.peak = 0; this.sum = 0; this.n = 0; this.total = 0; }
  push(chunk) {
    let buf = chunk;
    if (this.carry) { buf = Buffer.concat([this.carry, chunk]); this.carry = null; }
    const usable = buf.length - (buf.length % 2);
    if (usable < buf.length) this.carry = buf.subarray(usable);
    for (let off = 0; off < usable; off += 2) {
      const s = buf.readInt16LE(off);
      const a = s < 0 ? -s : s;
      if (a > this.peak) this.peak = a;
      this.sum += s * s;
      if (++this.n === WAVEFORM_BLOCK) this.flush();
    }
    this.total += usable / 2;
  }
  flush() {
    if (!this.n) return;
    this.peaks.push(this.peak); this.sums.push(this.sum); this.counts.push(this.n);
    this.peak = 0; this.sum = 0; this.n = 0;
  }
  finish(points = WAVEFORM_POINTS) {
    this.flush();
    const blocks = this.peaks.length;
    const out = [];
    for (let i = 0; i < points; i++) {
      const from = Math.floor(i * blocks / points);
      const to = Math.max(from + 1, Math.floor((i + 1) * blocks / points));
      let peak = 0, sum = 0, n = 0;
      for (let b = from; b < to && b < blocks; b++) {
        if (this.peaks[b] > peak) peak = this.peaks[b];
        sum += this.sums[b]; n += this.counts[b];
      }
      if (!n) { out.push(0); continue; }
      const amp = (peak / 32768) * 0.7 + (Math.sqrt(sum / n) / 32768) * 0.3;
      out.push(Math.min(Math.pow(amp, 0.6), 1));
    }
    return out;
  }
  get durationSeconds() { return this.total / WAVEFORM_HZ; }
}

export function createAudioCache({ s3, bucket, outputHz = '16000', acquireFfmpeg = async () => {}, releaseFfmpeg = () => {}, onOriginalFetch = () => {}, tmpDir = os.tmpdir(), ffmpegBin = 'ffmpeg' }) {
  // cacheKey -> { path, size, expiresAt, readers, uploading }
  const local = new Map();
  const converting = new Map(); // cacheKey -> Promise<entry>
  const waveforms = new Map(); // s3Key -> Promise<result>

  function removeIfIdle(key, entry) {
    if (entry.readers > 0 || entry.uploading || Date.now() < entry.expiresAt) return;
    if (local.get(key) === entry) local.delete(key);
    fs.unlink(entry.path, () => {});
  }
  const sweeper = setInterval(() => { for (const [k, e] of local) removeIfIdle(k, e); }, 30000);
  sweeper.unref?.();

  function localEntry(cacheKey) {
    const e = local.get(cacheKey);
    if (e && fs.existsSync(e.path)) return e;
    if (e) local.delete(cacheKey);
    return null;
  }

  async function fetchOriginal(s3Key, timeoutMs) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      onOriginalFetch(null);
      return obj;
    } catch (e) {
      onOriginalFetch(e);
      const err = new Error(`Original file not found: ${e.message}`); err.status = 404; throw err;
    }
  }

  function runFfmpeg(args, input, onStdout) {
    return new Promise((resolve, reject) => {
      const ff = spawn(ffmpegBin, args, { stdio: ['pipe', onStdout ? 'pipe' : 'ignore', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
      if (onStdout) ff.stdout.on('data', onStdout);
      ff.on('error', reject);
      ff.stdin.on('error', () => {}); // ffmpeg may stop reading early; its exit code reports problems
      input.on('error', e => ff.stdin.destroy(e));
      input.pipe(ff.stdin);
      ff.on('close', code => {
        // Release the source (and its S3 connection) whatever happened.
        if (!input.readableEnded) input.destroy?.();
        resolve({ code, stderr: stderr.trim() });
      });
    });
  }

  async function convert(s3Key, cacheKey, { timeoutMs = 20000, loglevel = 'warning' } = {}) {
    const original = await fetchOriginal(s3Key, timeoutMs);
    const outPath = path.join(tmpDir, `recbot-${cacheKey.replace(/\//g, '_')}-${crypto.randomBytes(4).toString('hex')}.wav`);
    await acquireFfmpeg();
    let result;
    try {
      result = await runFfmpeg(['-hide_banner', '-loglevel', loglevel, '-nostdin', '-i', 'pipe:0',
        '-fflags', '+discardcorrupt', '-err_detect', 'ignore_err',
        '-f', 'wav', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(outputHz), '-y', outPath], original.Body);
    } finally { releaseFfmpeg(); }
    let size = 0;
    try { size = fs.statSync(outPath).size; } catch {}
    // A non-zero exit can still leave usable output (minor decode errors); require some audio.
    if (size <= 1024) {
      fs.unlink(outPath, () => {});
      throw new Error(`Audio conversion failed (exit ${result.code}) ${result.stderr.slice(0, 300)}`);
    }
    const entry = { path: outPath, size, expiresAt: Date.now() + LOCAL_TTL_MS, readers: 0, uploading: true };
    const previous = local.get(cacheKey);
    local.set(cacheKey, entry);
    if (previous) { previous.expiresAt = 0; removeIfIdle(cacheKey, previous); }
    // Upload to the S3 cache in the background; playback is served from disk meanwhile.
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: cacheKey, Body: fs.createReadStream(outPath), ContentLength: size, ContentType: 'audio/wav' }))
      .then(() => console.log(`✅ [CACHED] Uploaded ${cacheKey} size=${size}`))
      .catch(e => console.error(`⚠️ [CACHE UPLOAD] ${cacheKey} failed: ${e.message}`))
      .finally(() => { entry.uploading = false; removeIfIdle(cacheKey, entry); });
    return { entry, code: result.code };
  }

  // Convert once per cache key; concurrent callers share the same conversion.
  function getOrConvert(s3Key, cacheKey, opts) {
    const ready = localEntry(cacheKey);
    if (ready) return Promise.resolve({ entry: ready, shared: true });
    if (!converting.has(cacheKey)) {
      const p = convert(s3Key, cacheKey, opts).finally(() => converting.delete(cacheKey));
      converting.set(cacheKey, p);
      return p;
    }
    return converting.get(cacheKey).then(r => ({ ...r, shared: true }));
  }

  // Serve a converted file from disk, honouring Range.
  function serveLocal(entry, cacheKey, req, res, filename) {
    entry.expiresAt = Date.now() + LOCAL_TTL_MS;
    const range = req.headers.range ? parseRange(req.headers.range, entry.size) : null;
    if (range?.unsatisfiable) {
      res.status(416).setHeader('Content-Range', `bytes */${entry.size}`);
      return res.end();
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    const opts = {};
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${entry.size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
      opts.start = range.start; opts.end = range.end;
    } else {
      res.setHeader('Content-Length', entry.size);
    }
    entry.readers++;
    const stream = fs.createReadStream(entry.path, opts);
    let done = false;
    const finish = () => { if (done) return; done = true; entry.readers--; removeIfIdle(cacheKey, entry); };
    pipeline(stream, res, err => {
      finish();
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('❌ [LOCAL STREAM ERR]', err.message);
    });
  }

  async function headExists(key) {
    try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) }); return true; }
    catch { return false; }
  }

  // Waveform: decode at 8 kHz and fold samples as they stream in. Uses the local converted
  // file if there is one (or one is being made), else the S3 cached WAV, else the original.
  async function buildWaveform(s3Key) {
    const cacheKey = audioCacheKey(s3Key);
    if (converting.has(cacheKey)) { try { await converting.get(cacheKey); } catch {} }
    const entry = localEntry(cacheKey);
    let input, source;
    if (entry) {
      entry.readers++;
      input = fs.createReadStream(entry.path); source = 'converted_cache';
      input.on('close', () => { entry.readers--; removeIfIdle(cacheKey, entry); });
    } else if (await headExists(cacheKey)) {
      input = (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cacheKey }))).Body; source = 'converted_cache';
    } else {
      input = (await fetchOriginal(s3Key, 20000)).Body; source = 'original_file';
    }
    const builder = new WaveformBuilder();
    const started = Date.now();
    await acquireFfmpeg();
    let result;
    try {
      result = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0',
        '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(WAVEFORM_HZ), 'pipe:1'], input, chunk => builder.push(chunk));
    } finally { releaseFfmpeg(); }
    if (result.code !== 0 && builder.total === 0) throw new Error(`Waveform ffmpeg exited ${result.code}: ${result.stderr.slice(0, 300)}`);
    const waveform = builder.finish();
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: waveformCacheKey(s3Key), Body: JSON.stringify(waveform), ContentType: 'application/json' }));
    } catch (e) { console.error(`⚠️ [WAVEFORM CACHE] Failed to cache: ${e.message}`); }
    return { waveform, generationTime: Date.now() - started, duration: builder.durationSeconds, sampleRate: WAVEFORM_HZ, totalSamples: builder.total, source };
  }

  function getWaveform(s3Key) {
    if (!waveforms.has(s3Key)) waveforms.set(s3Key, buildWaveform(s3Key).finally(() => waveforms.delete(s3Key)));
    return waveforms.get(s3Key);
  }

  return { localEntry, getOrConvert, serveLocal, getWaveform, _local: local, close: () => clearInterval(sweeper) };
}
