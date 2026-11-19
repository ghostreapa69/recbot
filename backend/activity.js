// Names what was running when the event loop was blocked. Requests and background jobs
// register while they run and are kept for a short while after they finish; a timer that
// fires late (the loop was busy) logs both lists right away.
import { performance } from 'perf_hooks';

const RECENT_MS = 30 * 1000;
const inFlight = new Map(); // id -> { label, start }
let recent = []; // { label, ms, end }
let nextId = 0;

function begin(label) {
  const id = ++nextId;
  inFlight.set(id, { label, start: Date.now() });
  return () => {
    const entry = inFlight.get(id);
    if (!entry) return;
    inFlight.delete(id);
    const end = Date.now();
    recent.push({ label: entry.label, ms: end - entry.start, end });
    if (recent.length > 200) recent = recent.slice(-200);
  };
}

// Express middleware: one entry per request, from arrival until the response closes.
export function trackRequests(req, res, next) {
  const done = begin(`${req.method} ${req.path.length > 80 ? `${req.path.slice(0, 80)}…` : req.path}`);
  res.once('close', done);
  next();
}

// Wraps a background job (scan, Five9 ingest, ...) so it shows up in the block report.
export async function trackJob(label, fn) {
  const done = begin(`job ${label}`);
  try {
    return await fn();
  } finally {
    done();
  }
}

const seconds = ms => `${(ms / 1000).toFixed(1)}s`;

export function describeActivity(now = Date.now()) {
  recent = recent.filter(r => now - r.end <= RECENT_MS);
  const running = [...inFlight.values()].map(e => `${e.label} (${seconds(now - e.start)})`);
  const finished = recent.map(r => `${r.label} ${r.ms >= 1000 ? seconds(r.ms) : `${r.ms}ms`}`);
  return { running, finished };
}

// Logs when a timer fires more than thresholdMs late, i.e. the event loop was blocked.
export function startBlockMonitor({ thresholdMs = 1000, intervalMs = 250, log = console } = {}) {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const blockedMs = Math.round(now - last - intervalMs);
    last = now;
    if (blockedMs < thresholdMs) return;
    // The blocking work usually ends within the block, so look at what just finished too:
    // anything that lasted at least as long as the block and ended within it.
    const wall = Date.now();
    const suspects = [
      ...[...inFlight.values()].filter(e => wall - e.start >= blockedMs).map(e => `${e.label} (still running, ${seconds(wall - e.start)})`),
      ...recent.filter(r => r.ms >= blockedMs && wall - r.end <= blockedMs + intervalMs).map(r => `${r.label} (${seconds(r.ms)})`)
    ];
    const { running, finished } = describeActivity(wall);
    log.warn(`🐢 [EVENT LOOP] blocked ${blockedMs}ms. Likely cause: ${suspects.join(', ') || 'unknown (not a tracked request or job)'}` +
      `\n   Running: ${running.join(', ') || 'nothing tracked'}` +
      `\n   Finished in the last 30s: ${finished.join(', ') || 'nothing'}`);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
