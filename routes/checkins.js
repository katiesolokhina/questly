const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const { messageForCheckin } = require('../lib/messages');
const { localToday, isYm } = require('../lib/dates');

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

module.exports = router;
