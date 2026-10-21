const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const { messageForCheckin } = require('../lib/messages');
const { localToday, localTime, isYm, isISODate, longDate, dow, DAY_FULL } = require('../lib/dates');
const icons = require('../lib/icons');

const router = express.Router();

// Back to the same habit (and month, if one was open) after the POST.
function backTo(habitId, m) {
  return `/?h=${habitId}${isYm(m) ? `&m=${m}` : ''}`;
}

// Loads the habit only if it belongs to the signed-in user.
async function ownHabit(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Habit.findOne({ _id: req.params.id, userId: req.user._id, archived: false });
}

// Check in for today. Idempotent: a double tap or a resubmitted form is a no-op.
router.post('/habits/:id/checkin', requireAuth, async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');

    const today = localToday(req.user.timezone);
    if (today < habit.startDate) return res.redirect(backTo(habit.id, req.body.m));

    const result = await Checkin.updateOne(
      { habitId: habit._id, date: today },
      { $setOnInsert: { userId: req.user._id, habitId: habit._id, date: today, checkedInAt: new Date(), source: 'live' } },
      { upsert: true }
    );

    // Only a brand-new check-in gets a message, and failures here never undo the check-in.
    if (result.upsertedCount) {
      try {
        const message = await messageForCheckin(req.user._id, today);
        await Checkin.updateOne({ habitId: habit._id, date: today }, { $set: { message } });
      } catch (err) {
        console.warn('Could not attach message:', err.message);
      }
    }

    res.redirect(backTo(habit.id, req.body.m));
  } catch (err) {
    next(err);
  }
});

// Undo today's check-in. Only today: past days are not editable from here.
router.post('/habits/:id/checkin/undo', requireAuth, async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    await Checkin.deleteOne({ habitId: habit._id, date: localToday(req.user.timezone) });
    res.redirect(backTo(habit.id, req.body.m));
  } catch (err) {
    next(err);
  }
});

// ---------- Fix past days ----------
// Any day from the habit's start date up to yesterday can be marked done or cleared.
// Today stays on the main button; the future can't be logged.

function pastDayError(habit, date, today) {
  if (!isISODate(date)) return 'Not a valid date.';
  if (date >= today) return 'Only past days can be changed here.';
  return null;
}

router.get('/habits/:id/day/:date', requireAuth, async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    const { date } = req.params;
    const today = localToday(req.user.timezone);
    const error = pastDayError(habit, date, today);
    if (error) return res.redirect(backTo(habit.id, req.query.m));

    const checkin = await Checkin.findOne({ habitId: habit._id, date }).lean();
    const scheduled = habit.isScheduledOn(dow(date));
    let status;
    if (checkin) {
      const when = checkin.source === 'import' ? 'Imported from your earlier tracking'
        : checkin.source === 'backfill' ? `Added later, on ${longDate(localToday(req.user.timezone, checkin.checkedInAt))}`
        : `Logged at ${localTime(checkin.checkedInAt, req.user.timezone)}`;
      status = { kind: 'done', title: 'Done', detail: when };
    } else if (date < habit.startDate) {
      status = { kind: 'before', title: 'Before this habit started', detail: `It started on ${longDate(habit.startDate)}.` };
    } else if (!scheduled) {
      status = { kind: 'off', title: 'Off day', detail: `Not scheduled on ${DAY_FULL[dow(date)]}s, so it doesn't count as missed.` };
    } else {
      status = { kind: 'missed', title: 'Missed', detail: 'Took it but forgot to log? Mark it done.' };
    }

    res.render('day', {
      habit, date, dateLabel: longDate(date), status, icons,
      back: backTo(habit.id, req.query.m), m: isYm(req.query.m) ? req.query.m : '',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/habits/:id/day/:date', requireAuth, async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    const { date } = req.params;
    const today = localToday(req.user.timezone);
    if (pastDayError(habit, date, today)) return res.status(400).send('Only past days can be changed.');

    if (req.body.action === 'add') {
      if (date < habit.startDate) return res.status(400).send('That day is before this habit started.');
      await Checkin.updateOne(
        { habitId: habit._id, date },
        { $setOnInsert: { userId: req.user._id, habitId: habit._id, date, checkedInAt: new Date(), source: 'backfill' } },
        { upsert: true }
      );
    } else if (req.body.action === 'remove') {
      await Checkin.deleteOne({ habitId: habit._id, date });
    } else {
      return res.status(400).send('Unknown action.');
    }
    res.redirect(backTo(habit.id, req.body.m || date.slice(0, 7)));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
