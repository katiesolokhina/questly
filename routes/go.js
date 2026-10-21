// Home-screen shortcuts (press and hold the app icon). The manifest can't know your habits,
// so each shortcut opens a fixed URL that picks the right place here.
// They only navigate: checking in still takes a tap, so a link can never check you in by itself.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const { localToday, dow } = require('../lib/dates');

const router = express.Router();

// The first habit still due today, else the first habit at all.
async function pick(user) {
  const today = localToday(user.timezone);
  const habits = await Habit.find({ userId: user._id, archived: false }).sort({ createdAt: 1 });
  if (!habits.length) return { habit: null, today };
  const doneIds = new Set((await Checkin.find({ userId: user._id, date: today }, { habitId: 1 }).lean()).map((c) => String(c.habitId)));
  const due = habits.find((h) => h.startDate <= today && h.isScheduledOn(dow(today)) && !h.pauseOn(today) && !doneIds.has(h.id));
  return { habit: due || habits[0], today };
}

router.get('/go/checkin', requireAuth, async (req, res, next) => {
  try {
    const { habit } = await pick(req.user);
    res.redirect(habit ? `/?h=${habit.id}` : '/');
  } catch (err) {
    next(err);
  }
});

router.get('/go/note', requireAuth, async (req, res, next) => {
  try {
    const { habit, today } = await pick(req.user);
    res.redirect(habit ? `/habits/${habit.id}/day/${today}#note` : '/');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
