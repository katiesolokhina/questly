const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const DayNote = require('../models/DayNote');
const D = require('./dates');
const { supplyView, goalView } = require('./counter');
const Rating = require('../models/Rating');
const R = require('./ratings');
const M = require('./milestones');

function listHabits(userId) {
  return Habit.find({ userId, archived: false }).sort({ createdAt: 1 });
}

// Everything the dashboard view needs for one habit and one month.
async function buildDashboard(user, habitId, ymParam) {
  const habits = await listHabits(user._id);
  if (!habits.length) return { habits, habit: null };

  const habit = habits.find((h) => h.id === habitId) || habits[0];
  const isScheduled = (dow) => habit.isScheduledOn(dow);
  const isPaused = (date) => Boolean(habit.pauseOn(date));
  const today = D.localToday(user.timezone);
  const currentYm = D.monthOf(today);
  const startYm = habit.startDate < today ? D.monthOf(habit.startDate) : currentYm;

  let ym = D.isYm(ymParam) ? ymParam : currentYm;
  if (ym > currentYm) ym = currentYm;
  if (ym < startYm) ym = startYm;

  const rows = await Checkin.find({ habitId: habit._id }, { date: 1, checkedInAt: 1, message: 1 }).lean();
  const done = new Set(rows.map((r) => r.date));
  const todayRow = rows.find((r) => r.date === today) || null;

  const stats = D.computeStats({ done, today, startDate: habit.startDate, isScheduled, isPaused, ym });
  const weeks = D.buildMonth(ym, { done, today, startDate: habit.startDate, isScheduled, isPaused });

  // Notes: a dot on days that have one, and today's note for the link under the check-in card.
  const notes = await DayNote.find({ habitId: habit._id, date: { $gte: `${ym}-01`, $lte: `${ym}-31` } }, { date: 1, text: 1 }).lean();
  const noted = new Set(notes.map((n) => n.date));
  for (const week of weeks) for (const cell of week) cell.hasNote = cell.inMonth && noted.has(cell.date);
  // Pause banner: the pause covering today, or the next one starting within 14 days.
  const soon = D.addDays(today, 14);
  const pauseNow = habit.pauseOn(today);
  const pauseNext = pauseNow || [...(habit.pauses || [])].sort((a, b) => (a.from < b.from ? -1 : 1)).find((p) => p.from > today && p.from <= soon);
  const pauseBanner = pauseNext && {
    active: Boolean(pauseNow),
    reason: Habit.PAUSE_REASONS[pauseNext.reason] || 'Break',
    range: `${D.longDate(pauseNext.from)} – ${D.longDate(pauseNext.to)}`,
  };
  const ctx = { today, done, startDate: habit.startDate, isScheduled, isPaused };
  const supply = supplyView(habit.supply, rows, ctx);
  const goal = goalView(habit.goal, rows, ctx);
  // Daily rating: today's chips, plus the trend for the month being viewed.
  const ratingCfg = R.ratingConfig(habit);
  let rating = null;
  if (ratingCfg) {
    const prevYm = D.shiftMonth(ym, -1);
    const rated = await Rating.find({ habitId: habit._id, date: { $gte: `${prevYm}-01`, $lte: `${ym}-31` } }, { date: 1, score: 1 }).lean();
    const ratings = new Map(rated.filter((r) => r.date.startsWith(ym)).map((r) => [r.date, r.score]));
    const prevScores = rated.filter((r) => r.date.startsWith(prevYm)).map((r) => r.score);
    const todayScore = (await Rating.findOne({ habitId: habit._id, date: today }, { score: 1 }).lean())?.score ?? null;
    rating = {
      question: ratingCfg.question,
      chips: R.chips(ratingCfg, todayScore),
      todayLabel: todayScore ? ratingCfg.labels[todayScore - 1] : null,
      trend: R.trend(ratingCfg, {
        ym, today, startDate: habit.startDate, ratings, prevScores, done,
        counts: (d) => isScheduled(D.dow(d)) && !isPaused(d),
      }),
    };
  }
  // Milestones + one-time celebrations (claimed atomically, so a reload never repeats one).
  let milestones = null;
  let celebrate = null;
  if (!habit.milestones || habit.milestones.enabled !== false) {
    const best = M.bestStreak(ctx);
    milestones = M.badges(best, habit.schedule.every, stats.streak);
    const seen = habit.milestones && habit.milestones.seen;
    if (!seen) {
      // First look at this habit since milestones existed: badges already earned don't pop up.
      await Habit.updateOne({ _id: habit._id, 'milestones.seen': { $exists: false } }, { $set: { 'milestones.seen': milestones.earned } });
    } else {
      const fresh = milestones.earned.filter((l) => !seen.includes(l));
      if (fresh.length) {
        const top = fresh[fresh.length - 1];
        const claimed = await Habit.updateOne(
          { _id: habit._id, 'milestones.seen': { $ne: top } },
          { $set: { 'milestones.seen': milestones.earned } }
        );
        if (claimed.modifiedCount) {
          celebrate = {
            kind: 'streak',
            big: habit.schedule.every ? `${top.toLocaleString('en-US')} days!` : `${top.toLocaleString('en-US')} in a row!`,
            badge: top.toLocaleString('en-US'),
            badgeUnit: habit.schedule.every ? 'DAYS' : 'IN A ROW',
            text: `${habit.name}, ${habit.schedule.every ? 'every single day' : 'every scheduled day'} for ${top.toLocaleString('en-US')} ${habit.schedule.every ? 'days' : 'times'} in a row. That's a new badge.`,
          };
        }
      }
    }
  }
  if (!celebrate && goal && goal.reached && !habit.goal.celebrated) {
    const claimed = await Habit.updateOne({ _id: habit._id, 'goal.celebrated': { $ne: true } }, { $set: { 'goal.celebrated': true } });
    if (claimed.modifiedCount) {
      celebrate = {
        kind: 'goal',
        big: 'Goal reached!',
        badge: goal.target.toLocaleString('en-US'),
        badgeUnit: goal.unit.toUpperCase().slice(0, 12),
        text: `${habit.name}: ${goal.label === 'Goal' ? 'you hit' : `${goal.label} done,`} ${goal.target.toLocaleString('en-US')} ${goal.unit}.`,
      };
    }
  }

  const todayNote = await DayNote.findOne({ habitId: habit._id, date: today }, { text: 1 }).lean();

  return {
    habits,
    habit,
    today,
    todayLabel: D.longDate(today),
    todayDayName: D.DAY_FULL[D.dow(today)],
    scheduleLabel: D.scheduleLabel(habit.schedule),
    scheduledToday: isScheduled(D.dow(today)) && !pauseNow,
    pausedToday: Boolean(pauseNow),
    pauseBanner,
    supply,
    goal,
    rating,
    milestones,
    celebrate,
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
