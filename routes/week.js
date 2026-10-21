const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Habit = require('../models/Habit');
const icons = require('../lib/icons');
const { isISODate, localToday, addDays } = require('../lib/dates');
const { mondayOf, buildWeek } = require('../lib/weekly');

const router = express.Router();

// /week = this week; /week?w=YYYY-MM-DD = the week containing that date.
router.get('/week', requireAuth, async (req, res, next) => {
  try {
    const today = localToday(req.user.timezone);
    const current = mondayOf(today);
    const first = await Habit.findOne({ userId: req.user._id, archived: false }, { startDate: 1 }).sort({ startDate: 1 }).lean();
    const earliest = first ? mondayOf(first.startDate) : current;
    let from = isISODate(req.query.w) ? mondayOf(req.query.w) : current;
    if (from > current) from = current;
    if (from < earliest) from = earliest;

    const week = await buildWeek(req.user, from, today);
    res.render('week', {
      week,
      icons,
      prev: from > earliest ? addDays(from, -7) : null,
      next: from < current ? addDays(from, 7) : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
