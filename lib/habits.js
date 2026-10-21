const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const DayNote = require('../models/DayNote');
const D = require('./dates');

function listHabits(userId) {
  return Habit.find({ userId, archived: false }).sort({ createdAt: 1 });
}

// Everything the dashboard view needs for one habit and one month.
async function buildDashboard(user, habitId, ymParam) {
  const habits = await listHabits(user._id);
  if (!habits.length) return { habits, habit: null };

  const habit = habits.find((h) => h.id === habitId) || habits[0];
  const isScheduled = (dow) => habit.isScheduledOn(dow);
  const today = D.localToday(user.timezone);
  const currentYm = D.monthOf(today);
  const startYm = habit.startDate < today ? D.monthOf(habit.startDate) : currentYm;

  let ym = D.isYm(ymParam) ? ymParam : currentYm;
  if (ym > currentYm) ym = currentYm;
  if (ym < startYm) ym = startYm;

  const rows = await Checkin.find({ habitId: habit._id }, { date: 1, checkedInAt: 1, message: 1 }).lean();
  const done = new Set(rows.map((r) => r.date));
  const todayRow = rows.find((r) => r.date === today) || null;

  const stats = D.computeStats({ done, today, startDate: habit.startDate, isScheduled, ym });
  const weeks = D.buildMonth(ym, { done, today, startDate: habit.startDate, isScheduled });

  // Notes: a dot on days that have one, and today's note for the link under the check-in card.
  const notes = await DayNote.find({ habitId: habit._id, date: { $gte: `${ym}-01`, $lte: `${ym}-31` } }, { date: 1, text: 1 }).lean();
  const noted = new Set(notes.map((n) => n.date));
  for (const week of weeks) for (const cell of week) cell.hasNote = cell.inMonth && noted.has(cell.date);
  const todayNote = await DayNote.findOne({ habitId: habit._id, date: today }, { text: 1 }).lean();

  return {
    habits,
    habit,
    today,
    todayLabel: D.longDate(today),
    todayDayName: D.DAY_FULL[D.dow(today)],
    scheduleLabel: D.scheduleLabel(habit.schedule),
    scheduledToday: isScheduled(D.dow(today)),
    todayCheckin: todayRow && {
      time: D.localTime(todayRow.checkedInAt, user.timezone),
      message: todayRow.message || null,
    },
    stats,
    streakUnit: habit.schedule.every ? 'days in a row' : 'in a row',
    totalUnit: habit.kind === 'medication' ? 'doses logged' : 'check-ins',
    ym,
    monthLabel: D.monthLabel(ym),
    monthShort: D.monthShort(ym),
    prevYm: ym > startYm ? D.shiftMonth(ym, -1) : null,
    nextYm: ym < currentYm ? D.shiftMonth(ym, 1) : null,
    todayNote: todayNote ? todayNote.text : null,
    weekHead: D.DAY_SHORT.map((s, i) => ({ letter: s[0], full: D.DAY_FULL[i], scheduled: isScheduled(i) })),
    weeks,
  };
}

module.exports = { listHabits, buildDashboard };
