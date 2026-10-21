// Once a minute: for every habit with a reminder, send it if it's due,
// the habit is scheduled today, and today isn't checked in yet.
//
// - "Due" means the reminder time has passed within the last hour. The window
//   covers a restart or a missed tick without firing a 9am reminder at 11pm.
// - Medications get one follow-up 2 hours after the reminder time.
// - ReminderLog's unique index guarantees each reminder goes out once per day,
//   even if two ticks overlap or the app restarts.

const User = require('../models/User');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const ReminderLog = require('../models/ReminderLog');
const { sendToUser } = require('./push');
const { localToday, dow } = require('./dates');
const { supplyView } = require('./counter');
const { mondayOf, buildWeek, pushText } = require('./weekly');
const pollen = require('./pollen');

const POLLEN_FROM_MIN = 6 * 60; // fetch each location's pollen once a day, from 6 AM local

const WEEKLY_MIN = 19 * 60; // Sundays at 7 PM local, within the usual 1-hour window

// "Running low" pushes go out once per refill, during the day only:
// from the habit's reminder time (or 9:00) until 9 PM.
const SUPPLY_QUIET_END_MIN = 21 * 60;

const WINDOW_MIN = 60;
const FOLLOWUP_AFTER_MIN = 120;

function localMinutes(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Which reminder (if any) is due right now for this habit.
function dueKind(habit, nowMin) {
  const t = toMinutes(habit.reminder.time);
  if (nowMin >= t && nowMin < t + WINDOW_MIN) return 'first';
  const f = t + FOLLOWUP_AFTER_MIN;
  if (habit.kind === 'medication' && f < 24 * 60 && nowMin >= f && nowMin < f + WINDOW_MIN) return 'followup';
  return null;
}

function message(habit, kind) {
  if (habit.kind === 'medication') {
    return kind === 'first' ? "Time for today's dose. Tap to check in." : "Today's dose isn't logged yet.";
  }
  return kind === 'first' ? 'Time to check in for today.' : "Today isn't checked in yet.";
}

function supplyMessage(v) {
  if (v.out) return `You're out of ${v.unit}. Tap "Add a refill" once you restock.`;
  return `About ${v.daysLeft} day${v.daysLeft === 1 ? '' : 's'} of ${v.unit} left. Time to reorder.`;
}

async function supplyAlerts(user, today, nowMin) {
  const habits = await Habit.find({ userId: user._id, archived: false, 'supply.enabled': true });
  for (const habit of habits) {
    const s = habit.supply;
    if (s.lowSentFor && s.baseAt && s.lowSentFor.getTime() === s.baseAt.getTime()) continue; // already sent for this refill
    const from = toMinutes(habit.reminder && habit.reminder.enabled ? habit.reminder.time : '09:00');
    if (nowMin < from || nowMin >= SUPPLY_QUIET_END_MIN) continue;

    const rows = await Checkin.find({ habitId: habit._id, date: { $gte: s.baseDate || habit.startDate } }, { date: 1, checkedInAt: 1 }).lean();
    const done = new Set(rows.map((r) => r.date));
    const v = supplyView(s, rows, {
      today, done, startDate: habit.startDate,
      isScheduled: (d) => habit.isScheduledOn(d), isPaused: (d) => Boolean(habit.pauseOn(d)),
    });
    if (!v || !v.low) continue;

    // Claim it atomically so two ticks (or two servers) can't both send.
    const claimed = await Habit.updateOne(
      { _id: habit._id, 'supply.baseAt': s.baseAt, 'supply.lowSentFor': { $ne: s.baseAt } },
      { $set: { 'supply.lowSentFor': s.baseAt } }
    );
    if (!claimed.modifiedCount) continue;
    await sendToUser(user._id, { title: habit.name, body: supplyMessage(v), url: `/?h=${habit.id}`, tag: `supply-${habit.id}` });
  }
}

async function weeklySummary(user, today, nowMin) {
  if (user.weeklySummary === false || dow(today) !== 0) return;
  if (nowMin < WEEKLY_MIN || nowMin >= WEEKLY_MIN + WINDOW_MIN) return;
  if (user.weeklySentFor === today) return;
  const claimed = await User.updateOne({ _id: user._id, weeklySentFor: { $ne: today } }, { $set: { weeklySentFor: today } });
  if (!claimed.modifiedCount) return;
  const week = await buildWeek(user, mondayOf(today), today);
  if (!week.expected) return; // nothing was due: stay quiet
  const { title, body } = pushText(week);
  await sendToUser(user._id, { title, body, url: `/week?w=${week.from}`, tag: 'weekly' });
}

async function tick(now = new Date()) {
  const users = await User.find({ disabled: { $ne: true } }, { timezone: 1, weeklySummary: 1, weeklySentFor: 1, pollen: 1 });
  for (const user of users) {
    const today = localToday(user.timezone, now);
    const nowMin = localMinutes(user.timezone, now);
    // Pollen: pre-fetch so the dashboard never waits. ensureToday is a no-op once today is stored.
    if (user.pollen && user.pollen.lat != null && nowMin >= POLLEN_FROM_MIN) await pollen.ensureToday(user.pollen, today);
    try {
      await weeklySummary(user, today, nowMin);
    } catch (err) {
      console.error('Weekly summary failed:', err.message);
    }
    try {
      await supplyAlerts(user, today, nowMin);
    } catch (err) {
      console.error('Supply alert failed:', err.message); // never blocks the daily reminders
    }
    const habits = await Habit.find({ userId: user._id, archived: false, 'reminder.enabled': true });

    for (const habit of habits) {
      if (today < habit.startDate || !habit.isScheduledOn(dow(today)) || habit.pauseOn(today)) continue;
      const kind = dueKind(habit, nowMin);
      if (!kind) continue;
      if (await Checkin.exists({ habitId: habit._id, date: today })) continue;

      // Claim this reminder first; if the claim already exists it was sent before.
      try {
        await ReminderLog.create({ habitId: habit._id, date: today, kind });
      } catch (err) {
        if (err.code === 11000) continue;
        throw err;
      }
      await sendToUser(user._id, {
        title: habit.name,
        body: message(habit, kind),
        url: `/?h=${habit.id}`,
        tag: `habit-${habit.id}`,
      });
    }
  }
}

function startReminders() {
  let running = false;
  const run = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error('Reminder tick failed:', err.message);
    } finally {
      running = false;
    }
  };
  // Align to the top of each minute so a 9:00 reminder fires at 9:00, not 9:00:59.
  setTimeout(() => {
    run();
    setInterval(run, 60 * 1000);
  }, (60 - new Date().getSeconds()) * 1000);
}

module.exports = { startReminders, tick, dueKind, localMinutes, supplyMessage };
