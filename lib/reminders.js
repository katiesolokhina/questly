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

async function tick(now = new Date()) {
  const users = await User.find({ disabled: { $ne: true } }, { timezone: 1 });
  for (const user of users) {
    const today = localToday(user.timezone, now);
    const nowMin = localMinutes(user.timezone, now);
    const habits = await Habit.find({ userId: user._id, archived: false, 'reminder.enabled': true });

    for (const habit of habits) {
      if (today < habit.startDate || !habit.isScheduledOn(dow(today))) continue;
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

module.exports = { startReminders, tick, dueKind, localMinutes };
