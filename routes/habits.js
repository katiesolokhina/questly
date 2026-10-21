const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const ReminderLog = require('../models/ReminderLog');
const DayNote = require('../models/DayNote');
const icons = require('../lib/icons');
const { DAY_SHORT, DAY_FULL, isISODate, localToday } = require('../lib/dates');

const router = express.Router();
router.use('/habits', requireAuth);

const EMPTY = { name: '', kind: 'habit', icon: 'leaf', every: true, days: [1, 2, 3, 4, 5], startDate: '', reminderOn: false, reminderTime: '09:00', description: '', linkUrl: '', linkLabel: '' };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Accepts only http(s) URLs, so a link can never be "javascript:…". Adds https:// if missing.
function cleanUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return { url: '' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Links must start with https://' };
    if (!u.hostname.includes('.')) return { error: 'Enter a full web address, like quello.com' };
    return { url: u.href.slice(0, 500) };
  } catch {
    return { error: 'That doesn’t look like a web address.' };
  }
}

// Form body → clean values + list of errors. Never trusts the browser.
function parseForm(body, today) {
  const name = String(body.name || '').trim();
  const kind = body.kind === 'medication' ? 'medication' : 'habit';
  const icon = Object.hasOwn(icons, body.icon) ? body.icon : 'leaf';
  const every = body.schedule !== 'specific';
  const rawDays = [].concat(body.days || []); // one checkbox → string, several → array
  const days = [...new Set(rawDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const startDate = String(body.startDate || '') || today;
  const reminderOn = body.reminderOn === 'on';
  const reminderTime = String(body.reminderTime || '09:00');
  const description = String(body.description || '').trim().replace(/\r\n/g, '\n');
  const linkLabel = String(body.linkLabel || '').trim();
  const link = cleanUrl(body.linkUrl);
  const linkUrl = link.url ?? String(body.linkUrl || '').trim();

  const errors = {};
  if (!name) errors.name = 'Give it a name.';
  else if (name.length > 40) errors.name = 'Keep it to 40 characters or fewer.';
  if (!every && !days.length) errors.days = 'Pick at least one day.';
  if (!isISODate(startDate)) errors.startDate = 'Enter a valid date.';
  if (reminderOn && !TIME.test(reminderTime)) errors.reminderTime = 'Pick a time.';
  if (description.length > 300) errors.description = 'Keep details to 300 characters or fewer.';
  if (link.error) errors.linkUrl = link.error;
  if (linkLabel.length > 40) errors.linkLabel = 'Keep the label to 40 characters or fewer.';

  return { values: { name, kind, icon, every, days, startDate, reminderOn, reminderTime, description, linkUrl, linkLabel }, errors };
}

function toDoc(v) {
  return {
    name: v.name,
    kind: v.kind,
    icon: v.icon,
    schedule: { every: v.every, days: v.every ? [0, 1, 2, 3, 4, 5, 6] : v.days },
    startDate: v.startDate,
    reminder: { enabled: v.reminderOn, time: TIME.test(v.reminderTime) ? v.reminderTime : '09:00' },
    description: v.description,
    link: { url: v.linkUrl, label: v.linkUrl ? v.linkLabel : '' },
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
      reminderOn: Boolean(habit.reminder && habit.reminder.enabled),
      reminderTime: (habit.reminder && habit.reminder.time) || '09:00',
      description: habit.description || '',
      linkUrl: (habit.link && habit.link.url) || '',
      linkLabel: (habit.link && habit.link.label) || '',
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

// ---------- Delete permanently ----------
// Unlike archive, this erases the habit and every check-in. Habits with history
// require typing the name, so years of data can't disappear from one mis-tap.

async function anyOwnHabit(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Habit.findOne({ _id: req.params.id, userId: req.user._id }); // archived or not
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

router.get('/habits/:id/delete', async (req, res, next) => {
  try {
    const habit = await anyOwnHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    const count = await Checkin.countDocuments({ habitId: habit._id });
    const from = req.query.from === 'settings' ? 'settings' : 'edit';
    res.render('delete-habit', { habit, count, from, error: null, icons });
  } catch (err) {
    next(err);
  }
});

router.post('/habits/:id/delete', async (req, res, next) => {
  try {
    const habit = await anyOwnHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    const count = await Checkin.countDocuments({ habitId: habit._id });
    const from = req.body.from === 'settings' ? 'settings' : 'edit';

    if (count > 0 && !sameName(req.body.confirmName, habit.name)) {
      return res.status(422).render('delete-habit', {
        habit, count, from, icons, error: `Type "${habit.name}" exactly to confirm.`,
      });
    }

    await Checkin.deleteMany({ habitId: habit._id });
    await ReminderLog.deleteMany({ habitId: habit._id });
    await DayNote.deleteMany({ habitId: habit._id });
    await Habit.deleteOne({ _id: habit._id });
    res.redirect(from === 'settings' ? '/settings?saved=deleted' : '/');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
