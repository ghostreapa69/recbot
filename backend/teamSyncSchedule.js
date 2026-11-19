// When the Five9 team sync runs: once a day at 9 PM (default), or every 6 hours.
// Chosen with FIVE9_TEAM_SYNC_SCHEDULE=9pm|6h. Timers are injectable for tests.
import dayjs from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

const DAILY_HOUR = 21;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

// The next 9 PM in `tz` strictly after `nowMs`, as epoch ms.
export function next9pm(nowMs, tz) {
  const now = dayjs(nowMs).tz(tz);
  const at = day => dayjs.tz(`${day.format('YYYY-MM-DD')}T${DAILY_HOUR}:00:00`, tz);
  let target = at(now);
  if (target.valueOf() <= nowMs) target = at(now.add(1, 'day'));
  return target.valueOf();
}

export function scheduleTeamSync({ schedule, run, tz, now = () => Date.now(), timers = { setTimeout, setInterval }, log = console }) {
  let mode = String(schedule || '9pm').trim().toLowerCase();
  if (mode !== '9pm' && mode !== '6h') {
    log.warn(`⚠️ [FIVE9 TEAMS] Unknown FIVE9_TEAM_SYNC_SCHEDULE "${schedule}"; using 9pm`);
    mode = '9pm';
  }
  if (mode === '6h') {
    timers.setTimeout(run, STARTUP_DELAY_MS);
    timers.setInterval(run, SIX_HOURS_MS);
    log.log('👥 [FIVE9 TEAMS] Sync schedule: a minute after start, then every 6 hours');
    return mode;
  }
  // Re-armed after each run, so daylight-saving changes don't move it off 9 PM.
  const arm = () => {
    const at = next9pm(now(), tz);
    timers.setTimeout(() => { arm(); run(); }, at - now());
    return at;
  };
  const at = arm();
  log.log(`👥 [FIVE9 TEAMS] Sync schedule: daily at 9 PM (${tz}); next run ${dayjs(at).tz(tz).format('YYYY-MM-DD h:mm A')}`);
  return mode;
}
