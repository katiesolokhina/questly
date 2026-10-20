const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Habit = require('../models/Habit');
const icons = require('../lib/icons');
const { DAY_SHORT, DAY_FULL, isISODate, localToday } = require('../lib/dates');

const router = express.Router();
router.use('/habits', requireAuth);

const EMPTY = { name: '', kind: 'habit', icon: 'leaf', every: true, days: [1, 2, 3, 4, 5], startDate: '' };

// Form body → clean values + list of errors. Never trusts the browser.
function parseForm(body, today) {
  const name = String(body.name || '').trim();
  const kind = body.kind === 'medication' ? 'medication' : 'habit';
  const icon = Object.hasOwn(icons, body.icon) ? body.icon : 'leaf';
  const every = body.schedule !== 'specific';
  const rawDays = [].concat(body.days || []); // one checkbox → string, several → array
  const days = [...new Set(rawDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const startDate = String(body.startDate || '') || today;

  const errors = {};
  if (!name) errors.name = 'Give it a name.';
  else if (name.length > 40) errors.name = 'Keep it to 40 characters or fewer.';
  if (!every && !days.length) errors.days = 'Pick at least one day.';
  if (!isISODate(startDate)) errors.startDate = 'Enter a valid date.';

  return { values: { name, kind, icon, every, days, startDate }, errors };
}

function toDoc(v) {
  return {
    name: v.name,
    kind: v.kind,
    icon: v.icon,
    schedule: { every: v.every, days: v.every ? [0, 1, 2, 3, 4, 5, 6] : v.days },
    startDate: v.startDate,
  };
}

function render(res, { mode, habitId = null, values, errors = {}, today }) {
  res.status(Object.keys(errors).length ? 422 : 200).render('habit-form', {
    mode, habitId, values, errors, today, icons, DAY_SHORT, DAY_FULL,
  });
}

async function ownHabit(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Habit.findOne({ _id: req.params.id, userId: req.user._id, archived: false });
}

// New
router.get('/habits/new', (req, res) => {
  const today = localToday(req.user.timezone);
  render(res, { mode: 'new', values: { ...EMPTY, startDate: today }, today });
});

router.post('/habits', async (req, res, next) => {
  try {
    const today = localToday(req.user.timezone);
    const { values, errors } = parseForm(req.body, today);
    if (Object.keys(errors).length) return render(res, { mode: 'new', values, errors, today });
    const habit = await Habit.create({ userId: req.user._id, ...toDoc(values) });
    res.redirect(`/?h=${habit.id}`);
  } catch (err) {
    next(err);
  }
});

// Edit
router.get('/habits/:id/edit', async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    const values = {
      name: habit.name,
      kind: habit.kind,
      icon: habit.icon,
      every: habit.schedule.every,
      days: habit.schedule.every ? EMPTY.days : [...habit.schedule.days],
      startDate: habit.startDate,
    };
    render(res, { mode: 'edit', habitId: habit.id, values, today: localToday(req.user.timezone) });
  } catch (err) {
    next(err);
  }
});

router.post('/habits/:id', async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    const today = localToday(req.user.timezone);
    const { values, errors } = parseForm(req.body, today);
    if (Object.keys(errors).length) return render(res, { mode: 'edit', habitId: habit.id, values, errors, today });
    habit.set(toDoc(values));
    await habit.save();
    res.redirect(`/?h=${habit.id}`);
  } catch (err) {
    next(err);
  }
});

// Archive: hides the habit, keeps every check-in.
router.post('/habits/:id/archive', async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    habit.archived = true;
    await habit.save();
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
