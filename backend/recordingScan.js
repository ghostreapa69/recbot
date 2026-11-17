// The 5-minute recording scan: index today's new recordings, ask Five9 for the
// call log rows of recordings that don't have one yet, and copy each call's
// agent and customer onto its recording. Dependencies are passed in so the
// scan can be tested without S3 or Five9.
import dayjs from 'dayjs';

// Recordings whose Five9 call log row hasn't arrived are looked up for this long.
export const SCAN_FIVE9_LOOKBACK_HOURS = 6;
// At most one scan-triggered Five9 report this often (Five9 rows can lag the recording).
export const SCAN_FIVE9_MIN_GAP_MS = 10 * 60 * 1000;
// The report window starts this long before the oldest missing call.
const WINDOW_PADDING_MS = 10 * 60 * 1000;

export function createRecordingScan({ listDayFiles, insertNewFiles, fillFileAgents, getRecentFilesMissingFive9, fetchCallLog, five9Configured, now = () => Date.now(), log = console }) {
  let lastFive9Fetch = 0;
  let running = false;

  return async function scan() {
    if (running) return null;
    running = true;
    try {
      const today = dayjs(now()).format('M_D_YYYY');
      const dayFiles = await listDayFiles(today);
      const added = dayFiles.length ? await insertNewFiles(dayFiles) : 0;

      // Today and yesterday, so calls near midnight still get matched.
      const sinceDate = dayjs(now()).subtract(1, 'day').format('YYYY-MM-DD');
      const filled = await fillFileAgents({ sinceDate });

      let five9 = 'not needed';
      const missing = await getRecentFilesMissingFive9(SCAN_FIVE9_LOOKBACK_HOURS);
      if (missing.count > 0 && !five9Configured) {
        five9 = 'not configured';
      } else if (missing.count > 0 && now() - lastFive9Fetch < SCAN_FIVE9_MIN_GAP_MS) {
        five9 = `waiting (${missing.count} calls missing)`;
      } else if (missing.count > 0) {
        lastFive9Fetch = now();
        const start = new Date(new Date(missing.earliest).getTime() - WINDOW_PADDING_MS);
        const result = await fetchCallLog({ start, end: new Date(now()) });
        five9 = `fetched ${result.total ?? 0} rows for ${missing.count} missing calls${result.error ? ` (error: ${result.error})` : ''}`;
        const after = await fillFileAgents({ sinceDate });
        filled.matched += after.matched;
        filled.fallback += after.fallback;
      }
      const summary = { today, recordings: dayFiles.length, added, ...filled, five9 };
      log.log(`🔄 [AUTO-SYNC] ${today}: ${dayFiles.length} recordings, ${added} new, ${filled.matched} matched to Five9, ${filled.fallback} from filename; Five9: ${five9}`);
      return summary;
    } catch (error) {
      log.error(`❌ [AUTO-SYNC] Error during current day sync:`, error.message);
      return null;
    } finally {
      running = false;
    }
  };
}
