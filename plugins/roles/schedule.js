/**
 * When the roles plugin should start a chief-of-staff run, and whether one is
 * still going. Run times are wall-clock "HH:MM" strings in the user's time
 * zone; a run "slot" is identified as "YYYY-MM-DD HH:MM", which sorts in time
 * order as a plain string.
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(time) {
  const [, hours, minutes] = time.match(TIME_RE);
  return Number(hours) * 60 + Number(minutes);
}

/** Valid run times, deduplicated and sorted; invalid entries are dropped. */
export function normalizeRunTimes(runTimes) {
  const valid = (Array.isArray(runTimes) ? runTimes : [])
    .map(t => String(t).trim())
    .filter(t => TIME_RE.test(t));
  return [...new Set(valid)].sort((a, b) => toMinutes(a) - toMinutes(b));
}

/** The local date (YYYY-MM-DD) and minutes past midnight of `date` in `timeZone`. */
export function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

/**
 * The most recent run slot at or before `now`: today's latest passed run
 * time, or yesterday's last one if none has passed yet today. Null when there
 * are no valid run times.
 */
export function latestRunSlot(now, runTimes, timeZone) {
  const times = normalizeRunTimes(runTimes);
  if (times.length === 0) {
    return null;
  }
  const { date, minutes } = localParts(now, timeZone);
  const passed = times.filter(t => toMinutes(t) <= minutes);
  if (passed.length > 0) {
    return `${date} ${passed[passed.length - 1]}`;
  }
  const yesterday = localParts(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone).date;
  return `${yesterday} ${times[times.length - 1]}`;
}

/** Whether a process with this PID is still running. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Decide what this sync should do, given the latest run slot and the saved
 * state ({ lastSlot, pid, startedAt }, or null before the first sync).
 * Returns { action, reason } where action is one of:
 *   'initialize' - first sync: remember the slot, wait for the next run time
 *   'wait'       - nothing due
 *   'skip'       - due, but the previous run is still going
 *   'start'      - start a run now
 */
export function decide(slot, state, { isAlive = isProcessAlive } = {}) {
  if (!slot) {
    return { action: 'wait', reason: 'no valid run_times configured' };
  }
  if (!state || !state.lastSlot) {
    return { action: 'initialize', reason: 'first sync: waiting for the next run time' };
  }
  if (state.lastSlot >= slot) {
    return { action: 'wait', reason: `not due (last run slot ${state.lastSlot})` };
  }
  if (state.pid && isAlive(state.pid)) {
    return { action: 'skip', reason: `the run started ${state.startedAt} is still going; skipped ${slot}` };
  }
  return { action: 'start', reason: `run due for ${slot}` };
}
