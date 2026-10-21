// Weekly summary: Monday–Sunday per habit, for the /week page and the Sunday push.
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const Rating = require('../models/Rating');
const D = require('./dates');
const { ratingConfig } = require('./ratings');

const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const SHORT = (d) => D.DAY_SHORT[D.dow(d)];

// Monday of the week containing `date`.
function mondayOf(date) {
  const w = D.dow(date);
  return D.addDays(date, w === 0 ? -6 : 1 - w);
}

function label(from) {
  const to = D.addDays(from, 6);
  const fmt = (d) => D.longDate(d).replace(',', '');
  return `${fmt(from)} – ${fmt(to)}`;
}

// One habit's week. `done` holds every check-in date (needed for the streak).
function habitWeek(habit, done, from, today) {
  const isScheduled = (w) => habit.isScheduledOn(w);
  const counts = (d) => d >= habit.startDate && isScheduled(D.dow(d)) && !habit.pauseOn(d);
  const days = [];
  let hit = 0;
  let expected = 0;
  let extra = 0;
  const missed = [];
  const pauses = new Set();
  for (let i = 0; i < 7; i++) {
    const d = D.addDays(from, i);
    const isDone = done.has(d);
    let status;
    if (d > today) status = 'future';
    else if (isDone) status = 'done';
    else if (d < habit.startDate) status = 'before';
    else if (habit.pauseOn(d)) { status = 'paused'; pauses.add(habit.pauseOn(d).reason); }
    else if (!isScheduled(D.dow(d))) status = 'off';
    else if (d === today) status = 'today';
    else { status = 'missed'; missed.push(SHORT(d)); }

    if (d <= today && counts(d) && !(d === today && !isDone)) {
      expected++;
      if (isDone) hit++;
    } else if (isDone && d <= today) {
      extra++; // a bonus check-in on an off or paused day
    }
    const names = { future: '', done: 'Done', before: 'Before start', paused: 'Paused', off: 'Off day', today: 'Today, not done yet', missed: 'Missed' };
    days.push({ date: d, letter: LETTERS[i], status, label: `${D.DAY_FULL[D.dow(d)]}: ${names[status] || 'Upcoming'}` });
  }
  return { days, hit, expected, extra, missed, pauses: [...pauses] };
}

async function buildWeek(user, from, today) {
  const to = D.addDays(from, 6);
  const habits = await Habit.find({ userId: user._id, archived: false, startDate: { $lte: to } }).sort({ createdAt: 1 });
  const prevFrom = D.addDays(from, -7);
  const rows = [];
  let hit = 0;
  let expected = 0;
  let prevHit = 0;
  let prevExpected = 0;

  for (const habit of habits) {
    const dates = await Checkin.find({ habitId: habit._id, date: { $lte: to } }, { date: 1 }).lean();
    const done = new Set(dates.map((c) => c.date));
    const w = habitWeek(habit, done, from, today);
    const p = habitWeek(habit, done, prevFrom, today);
    hit += w.hit; expected += w.expected; prevHit += p.hit; prevExpected += p.expected;

    const isScheduled = (d) => habit.isScheduledOn(d);
    const isPaused = (d) => Boolean(habit.pauseOn(d));
    const asOf = to < today ? to : today;
    const streak = D.computeStats({ done, today: asOf, startDate: habit.startDate, isScheduled, isPaused, ym: D.monthOf(asOf) }).streak;

    let note;
    if (w.missed.length) note = `Missed ${w.missed.join(', ')}`;
    else if (w.pauses.length) note = `Paused · ${w.pauses.map((r) => Habit.PAUSE_REASONS[r] || 'Break').join(', ')}`;
    else if (w.expected) note = `Streak ${streak.toLocaleString('en-US')}`;
    else note = 'Nothing scheduled yet';
    if (w.extra) note += ` · ${w.extra} bonus day${w.extra === 1 ? '' : 's'}`;

    let rating = null;
    const cfg = ratingConfig(habit);
    if (cfg) {
      const scores = (await Rating.find({ habitId: habit._id, date: { $gte: from, $lte: to } }, { score: 1 }).lean()).map((r) => r.score);
      if (scores.length) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        rating = `Rated ${scores.length} day${scores.length === 1 ? '' : 's'}, average ${avg.toFixed(1)} (${cfg.labels[Math.round(avg) - 1]})`;
      }
    }

    rows.push({
      id: habit.id,
      name: habit.name,
      icon: habit.icon,
      score: `${w.hit}/${w.expected}`,
      perfect: w.expected > 0 && w.hit === w.expected,
      streak,
      note,
      rating,
      days: w.days,
    });
  }

  // Mid-week numbers are "so far", and only a finished week (or Sunday itself) is compared with the last.
  const complete = to <= today;
  let headline;
  if (!expected) headline = 'Nothing was due yet this week.';
  else if (hit === expected) headline = complete ? `Perfect week: ${hit} of ${expected} check-ins` : `${hit} of ${expected} so far, all done`;
  else headline = `${hit} of ${expected} check-ins${complete ? '' : ' so far'}`;

  let compare = null;
  if (complete && expected && prevExpected) {
    const now = hit / expected;
    const before = prevHit / prevExpected;
    if (Math.abs(now - before) < 0.005) compare = `Same as last week (${prevHit} of ${prevExpected}).`;
    else compare = `${now > before ? 'Up' : 'Down'} from ${prevHit} of ${prevExpected} last week.`;
  }

  return { from, to, label: label(from), rows, hit, expected, headline, compare, isCurrent: from === mondayOf(today) };
}

// Push wording: "Your week: 9 of 10 check-ins" / "Quello drops 7/7 · streak 93. Gym 2/3."
function pushText(week) {
  const parts = week.rows
    .filter((r) => r.score !== '0/0')
    .slice(0, 3)
    .map((r) => `${r.name} ${r.score}${r.perfect && r.streak >= 7 ? ` · streak ${r.streak}` : ''}`);
  const more = week.rows.length > 3 ? ' and more' : '';
  return {
    title: week.hit === week.expected ? `Perfect week: ${week.hit} of ${week.expected} check-ins` : `Your week: ${week.hit} of ${week.expected} check-ins`,
    body: `${parts.join('. ')}${more}. Tap for details.`,
  };
}

module.exports = { mondayOf, buildWeek, habitWeek, pushText, label };
