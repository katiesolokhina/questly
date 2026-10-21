// All dates here are local calendar dates as 'YYYY-MM-DD' strings.
// Arithmetic is done on UTC midnights so DST shifts can never skip or repeat a day.

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

function isISODate(s) {
  return typeof s === 'string' && ISO.test(s) && toISO(parse(s)) === s;
}

function isYm(s) {
  return typeof s === 'string' && YM.test(s);
}

function addDays(s, n) {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

function dow(s) {
  return parse(s).getUTCDay();
}

// Inclusive count of days from a to b (a <= b).
function daysBetweenInclusive(a, b) {
  return Math.round((parse(b) - parse(a)) / 86400000) + 1;
}

// Today's date in the given IANA timezone.
function localToday(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function localTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(date);
}

function longDate(s) {
  const d = parse(s);
  return `${DAY_SHORT[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
}

function monthOf(s) {
  return s.slice(0, 7);
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function monthShort(ym) {
  return MONTHS[Number(ym.slice(5, 7)) - 1].slice(0, 3);
}

function scheduleLabel(schedule) {
  if (schedule.every) return 'Every day';
  return [...schedule.days].sort((a, b) => a - b).map((d) => DAY_SHORT[d]).join(', ');
}

/**
 * Sunday-first month grid. Each cell: { date, day, inMonth, status, label }.
 * status: 'done' | 'missed' | 'off' | 'today' | 'today-done' | 'future' | 'before-start'
 *   done          past day with a check-in (scheduled or logged anyway)
 *   missed        past scheduled day with no check-in
 *   off           past unscheduled day with no check-in
 */
function buildMonth(ym, { done, today, startDate, isScheduled, isPaused = () => false }) {
  const first = `${ym}-01`;
  const startOffset = dow(first);
  const daysInMonth = daysBetweenInclusive(first, `${shiftMonth(ym, 1)}-01`) - 1;
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const date = addDays(first, i - startOffset);
    const inMonth = monthOf(date) === ym;
    const isDone = done.has(date);
    const sched = isScheduled(dow(date));
    const paused = date >= startDate && isPaused(date);
    let status;
    let label;
    if (date === today) {
      status = isDone ? 'today-done' : 'today';
      label = isDone ? 'Today, done' : paused ? 'Today, paused' : sched ? 'Today, not done yet' : 'Today, off day';
    } else if (paused && !isDone) {
      // Paused days (past or planned) look the same: they never count as missed.
      status = 'paused';
      label = 'Paused';
    } else if (date > today) {
      status = 'future';
      label = '';
    } else if (isDone) {
      status = 'done';
      label = 'Done';
    } else if (date < startDate) {
      status = 'before-start';
      label = '';
    } else if (!sched) {
      status = 'off';
      label = 'Off day';
    } else {
      status = 'missed';
      label = 'Missed';
    }
    cells.push({ date, day: Number(date.slice(8)), inMonth, status, label });
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * Stats for one habit.
 * - streak: check-ins in the current unbroken run, counting back from today (or yesterday
 *   if today isn't done yet). Only a missed SCHEDULED day breaks it. Off days and paused
 *   days are skipped when empty, and add one when you checked in anyway (bonus days).
 * - total: every check-in on or before today.
 * - adherence: scheduled days done / scheduled days elapsed in the given month
 *   (today only counts once it's done).
 * - paused days behave like off days everywhere: skipped by the streak, left out of adherence.
 */
function computeStats({ done, today, startDate, isScheduled, isPaused = () => false, ym }) {
  const counts = (d) => isScheduled(dow(d)) && !isPaused(d); // a day that is expected to be done
  let cursor = done.has(today) || !counts(today) ? today : addDays(today, -1);
  let streak = 0;
  while (cursor >= startDate) {
    if (done.has(cursor)) streak++;
    else if (counts(cursor)) break;
    cursor = addDays(cursor, -1);
  }

  let total = 0;
  for (const d of done) if (d <= today) total++;

  const monthStart = `${ym}-01`;
  const monthEnd = addDays(`${shiftMonth(ym, 1)}-01`, -1);
  const from = monthStart > startDate ? monthStart : startDate;
  const to = monthEnd < today ? monthEnd : today;
  let eligible = 0;
  let hit = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!counts(d)) continue;
    if (d === today && !done.has(d)) continue;
    eligible++;
    if (done.has(d)) hit++;
  }

  return {
    streak,
    total,
    adherence: eligible ? Math.round((hit / eligible) * 100) : null,
    dayOfCourse: today >= startDate ? daysBetweenInclusive(startDate, today) : 0,
  };
}

module.exports = {
  DAY_SHORT,
  DAY_FULL,
  isISODate,
  isYm,
  addDays,
  dow,
  daysBetweenInclusive,
  localToday,
  localTime,
  longDate,
  monthOf,
  shiftMonth,
  monthLabel,
  monthShort,
  scheduleLabel,
  buildMonth,
  computeStats,
};
