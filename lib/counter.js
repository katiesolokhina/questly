// Counters: optional per habit, both derived from check-ins so undo, backfill and
// past-day fixes are always reflected. Nothing is decremented in place.
//
// Supply (countdown): "N left" = amount at the last refill/correction minus what
//   check-ins since then used. A check-in on the refill day only counts if it was
//   logged after the refill (that dose came from the old bottle otherwise).
// Goal (count-up): check-ins since `from` × amount per check-in, toward a target.
//
// Forecasts walk forward over days that count (scheduled, not paused), so a
// Mon/Wed/Fri habit or a planned trip pushes the run-out / finish date out.

const D = require('./dates');

const HORIZON_DAYS = 365 * 3; // stop forecasting past this

// "Fri, Oct 30", plus the year when it isn't this year.
function withYear(date, today) {
  return D.longDate(date) + (date.slice(0, 4) === today.slice(0, 4) ? '' : `, ${date.slice(0, 4)}`);
}

// Days from `from` on that are expected to be done, one at a time.
function* countingDays(from, { startDate, isScheduled, isPaused }) {
  let d = from < startDate ? startDate : from;
  const stop = D.addDays(from, HORIZON_DAYS);
  for (; d <= stop; d = D.addDays(d, 1)) {
    if (isScheduled(D.dow(d)) && !isPaused(d)) yield d;
  }
}

// First day still to do: today if it counts and isn't done yet, otherwise tomorrow.
function nextDay(today, done) {
  return done.has(today) ? D.addDays(today, 1) : today;
}

/**
 * @param supply  habit.supply (enabled, unit, perCheckin, size, base, baseAt, baseDate, warnDays, reorderUrl)
 * @param rows    check-ins: [{ date, checkedInAt }]
 */
function supplyView(supply, rows, ctx) {
  if (!supply || !supply.enabled) return null;
  const { today, done } = ctx;
  const per = supply.perCheckin || 1;
  const baseAt = supply.baseAt ? new Date(supply.baseAt).getTime() : 0;
  let usedCheckins = 0;
  for (const r of rows) {
    if (r.date > today) continue;
    if (r.date > supply.baseDate || (r.date === supply.baseDate && new Date(r.checkedInAt).getTime() > baseAt)) usedCheckins++;
  }
  const left = Math.max(0, supply.base - usedCheckins * per);

  // Walk forward: each counting day uses `per`. The first day that can't be covered is the run-out day.
  let remaining = left;
  let checkinsLeft = 0;
  let runsOut = null;
  const first = nextDay(today, done);
  for (const d of countingDays(first, ctx)) {
    if (remaining < per) { runsOut = d; break; }
    remaining -= per;
    checkinsLeft++;
  }
  // Calendar days still covered, from the next dose on (today if it isn't done yet, else tomorrow).
  const daysLeft = runsOut ? Math.max(0, D.daysBetweenInclusive(first, runsOut) - 1) : null;
  const warnDays = supply.warnDays ?? 7;
  const out = runsOut === today || left < per;
  return {
    unit: supply.unit || 'doses',
    left,
    size: supply.size,
    checkinsLeft,
    daysLeft,
    runsOut,
    runsOutLabel: runsOut ? withYear(runsOut, today) : null,
    low: out || (daysLeft !== null && daysLeft <= warnDays),
    out,
    warnDays,
    pct: supply.size ? Math.min(100, Math.round((left / supply.size) * 100)) : 0,
    reorderUrl: supply.reorderUrl || '',
  };
}

// The amount left right now, for prefilling the edit form and for "I got a refill".
function supplyLeft(supply, rows, today) {
  const v = supplyView({ ...supply, enabled: true }, rows, {
    today, done: new Set(), startDate: today, isScheduled: () => true, isPaused: () => false,
  });
  return v ? v.left : 0;
}

function goalView(goal, rows, ctx) {
  if (!goal || !goal.enabled || !goal.target) return null;
  const { today, done } = ctx;
  const per = goal.perCheckin || 1;
  const from = goal.from || ctx.startDate;
  let count = 0;
  for (const r of rows) if (r.date >= from && r.date <= today) count++;
  const progress = count * per;
  const reached = progress >= goal.target;

  let finish = null;
  if (!reached) {
    let need = Math.ceil((goal.target - progress) / per);
    for (const d of countingDays(nextDay(today, done), ctx)) {
      if (--need === 0) { finish = d; break; }
    }
  }
  return {
    label: goal.label || 'Goal',
    unit: goal.unit || 'check-ins',
    progress,
    target: goal.target,
    pct: Math.min(100, Math.floor((progress / goal.target) * 100)),
    reached,
    finish,
    finishLabel: finish ? withYear(finish, today) : null,
  };
}

module.exports = { supplyView, supplyLeft, goalView };
