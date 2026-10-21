const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const ReminderLog = require('../models/ReminderLog');
const DayNote = require('../models/DayNote');
const icons = require('../lib/icons');
const { supplyLeft } = require('../lib/counter');
const Rating = require('../models/Rating');
const { DEFAULTS: RATING_DEFAULTS, defaultsFor } = require('../lib/ratings');
const { DAY_SHORT, DAY_FULL, isISODate, localToday, longDate, daysBetweenInclusive } = require('../lib/dates');

const router = express.Router();
router.use('/habits', requireAuth);

const EMPTY = {
  name: '', kind: 'habit', icon: 'leaf', every: true, days: [1, 2, 3, 4, 5], startDate: '', reminderOn: false, reminderTime: '09:00', description: '', linkUrl: '', linkLabel: '',
  supplyOn: false, supplyLeft: '', supplySize: '30', supplyPer: '1', supplyUnit: 'doses', supplyWarn: '7', supplyUrl: '',
  goalOn: false, goalLabel: '', goalTarget: '', goalUnit: 'days', goalPer: '1', goalFrom: '',
  ratingOn: false, ratingQuestion: '', ratingLabels: ['', '', '', '', ''], ratingDir: '',
};
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

// Whole number in [min, max]. '' → null (not given), anything else invalid → NaN.
function intField(raw, min, max) {
  const t = String(raw ?? '').trim().replace(/,/g, '');
  if (!t) return null;
  if (!/^\d+$/.test(t)) return NaN;
  const n = Number(t);
  return n >= min && n <= max ? n : NaN;
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

  // Counters: raw strings are kept in `values` so a rejected form re-renders what was typed.
  const str = (k, d = '') => String(body[k] ?? d).trim();
  const supplyOn = body.supplyOn === 'on';
  const goalOn = body.goalOn === 'on';
  const supplyUrlCheck = cleanUrl(body.supplyUrl);
  const counters = {
    supplyOn, supplyLeft: str('supplyLeft'), supplySize: str('supplySize'), supplyPer: str('supplyPer', '1'),
    supplyUnit: str('supplyUnit'), supplyWarn: str('supplyWarn', '7'), supplyUrl: supplyUrlCheck.url ?? str('supplyUrl'),
    goalOn, goalLabel: str('goalLabel'), goalTarget: str('goalTarget'), goalUnit: str('goalUnit'), goalPer: str('goalPer', '1'), goalFrom: str('goalFrom'),
  };
  const nums = {
    supplyLeft: intField(counters.supplyLeft, 0, 100000),
    supplySize: intField(counters.supplySize, 1, 100000),
    supplyPer: intField(counters.supplyPer, 1, 1000),
    supplyWarn: intField(counters.supplyWarn, 0, 60),
    goalTarget: intField(counters.goalTarget, 1, 1000000),
    goalPer: intField(counters.goalPer, 1, 1000),
  };

  const ratingOn = body.ratingOn === 'on';
  const ratingQuestion = str('ratingQuestion');
  const ratingLabels = [1, 2, 3, 4, 5].map((i) => str(`ratingLabel${i}`));
  const ratingDir = ['low', 'high'].includes(body.ratingDir) ? body.ratingDir : (defaultsFor(kind).lowIsGood ? 'low' : 'high');
  Object.assign(counters, { ratingOn, ratingQuestion, ratingLabels, ratingDir });

  const errors = {};
  if (ratingQuestion.length > 80) errors.ratingQuestion = 'Keep it to 80 characters or fewer.';
  if (ratingLabels.some((l) => l.length > 16)) errors.ratingLabels = 'Keep each label to 16 characters or fewer.';
  if (supplyOn) {
    if (nums.supplySize === null) errors.supplySize = 'How much is in a full refill?';
    else if (Number.isNaN(nums.supplySize)) errors.supplySize = 'Enter a whole number from 1 to 100,000.';
    if (Number.isNaN(nums.supplyLeft)) errors.supplyLeft = 'Enter a whole number, 0 or more.';
    if (Number.isNaN(nums.supplyPer) || nums.supplyPer === null) errors.supplyPer = 'Enter a whole number from 1 to 1,000.';
    if (Number.isNaN(nums.supplyWarn) || nums.supplyWarn === null) errors.supplyWarn = 'Enter 0 to 60 days.';
    if (counters.supplyUnit.length > 20) errors.supplyUnit = 'Keep it to 20 characters or fewer.';
    if (supplyUrlCheck.error) errors.supplyUrl = supplyUrlCheck.error;
  }
  if (goalOn) {
    if (nums.goalTarget === null) errors.goalTarget = 'Set a target.';
    else if (Number.isNaN(nums.goalTarget)) errors.goalTarget = 'Enter a whole number from 1 to 1,000,000.';
    if (Number.isNaN(nums.goalPer) || nums.goalPer === null) errors.goalPer = 'Enter a whole number from 1 to 1,000.';
    if (counters.goalUnit.length > 20) errors.goalUnit = 'Keep it to 20 characters or fewer.';
    if (counters.goalLabel.length > 40) errors.goalLabel = 'Keep it to 40 characters or fewer.';
    if (counters.goalFrom && !isISODate(counters.goalFrom)) errors.goalFrom = 'Enter a valid date.';
  }
  if (!name) errors.name = 'Give it a name.';
  else if (name.length > 40) errors.name = 'Keep it to 40 characters or fewer.';
  if (!every && !days.length) errors.days = 'Pick at least one day.';
  if (!isISODate(startDate)) errors.startDate = 'Enter a valid date.';
  if (reminderOn && !TIME.test(reminderTime)) errors.reminderTime = 'Pick a time.';
  if (description.length > 300) errors.description = 'Keep details to 300 characters or fewer.';
  if (link.error) errors.linkUrl = link.error;
  if (linkLabel.length > 40) errors.linkLabel = 'Keep the label to 40 characters or fewer.';

  return { values: { name, kind, icon, every, days, startDate, reminderOn, reminderTime, description, linkUrl, linkLabel, ...counters }, nums, errors };
}

// Supply and goal subdocuments. The supply is re-anchored (amount left as of now)
// when it's first turned on or when "amount left" was changed on the form.
function counterDoc(v, nums, { habit, rows, today }) {
  const prev = habit && habit.supply && habit.supply.enabled ? habit.supply : null;
  const old = habit ? habit.toObject() : {};
  const supply = { ...(old.supply || {}), enabled: v.supplyOn };
  if (v.supplyOn) {
    Object.assign(supply, {
      unit: v.supplyUnit || 'doses',
      perCheckin: nums.supplyPer,
      size: nums.supplySize,
      warnDays: nums.supplyWarn,
      reorderUrl: v.supplyUrl,
    });
    const current = prev ? supplyLeft(prev, rows, today) : null;
    const wanted = nums.supplyLeft ?? current ?? nums.supplySize;
    if (!prev || wanted !== current) {
      Object.assign(supply, { base: wanted, baseAt: new Date(), baseDate: today, lowSentFor: undefined });
    }
  }
  const goal = { ...(old.goal || {}), enabled: v.goalOn };
  if (v.goalOn) {
    Object.assign(goal, {
      label: v.goalLabel,
      unit: v.goalUnit || 'check-ins',
      perCheckin: nums.goalPer,
      target: nums.goalTarget,
      from: v.goalFrom || v.startDate,
    });
  }
  // Rating: settings are kept when it's turned off, so turning it back on restores them.
  const rating = { enabled: v.ratingOn, question: v.ratingQuestion, labels: v.ratingLabels, lowIsGood: v.ratingDir === 'low' };
  return { supply, goal, rating };
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
    mode, habitId, values: { ...values, ratingDir: values.ratingDir || (defaultsFor(values.kind).lowIsGood ? 'low' : 'high') },
    errors, today, icons, DAY_SHORT, DAY_FULL, ratingDefaults: RATING_DEFAULTS,
  });
}

function checkinRows(habit) {
  return Checkin.find({ habitId: habit._id }, { date: 1, checkedInAt: 1 }).lean();
}

// Form values for an existing habit's counters. "Amount left" shows what's left right now.
async function counterValues(habit, today) {
  const s = habit.supply || {};
  const g = habit.goal || {};
  const left = s.enabled ? supplyLeft(s, await checkinRows(habit), today) : '';
  return {
    supplyOn: Boolean(s.enabled),
    supplyLeft: String(left),
    supplySize: String(s.size ?? EMPTY.supplySize),
    supplyPer: String(s.perCheckin ?? 1),
    supplyUnit: s.unit || EMPTY.supplyUnit,
    supplyWarn: String(s.warnDays ?? 7),
    supplyUrl: s.reorderUrl || '',
    goalOn: Boolean(g.enabled),
    goalLabel: g.label || '',
    goalTarget: g.target ? String(g.target) : '',
    goalUnit: g.unit || EMPTY.goalUnit,
    goalPer: String(g.perCheckin ?? 1),
    goalFrom: g.from || habit.startDate,
    ratingOn: Boolean(habit.rating && habit.rating.enabled),
    ratingQuestion: (habit.rating && habit.rating.question) || '',
    ratingLabels: [0, 1, 2, 3, 4].map((i) => (habit.rating && habit.rating.labels && habit.rating.labels[i]) || ''),
    ratingDir: habit.rating && typeof habit.rating.lowIsGood === 'boolean'
      ? (habit.rating.lowIsGood ? 'low' : 'high')
      : (defaultsFor(habit.kind).lowIsGood ? 'low' : 'high'),
  };
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
    const { values, nums, errors } = parseForm(req.body, today);
    if (Object.keys(errors).length) return render(res, { mode: 'new', values, errors, today });
    const habit = await Habit.create({ userId: req.user._id, ...toDoc(values), ...counterDoc(values, nums, { today }) });
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
      ...(await counterValues(habit, localToday(req.user.timezone))),
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
    const { values, nums, errors } = parseForm(req.body, today);
    if (Object.keys(errors).length) return render(res, { mode: 'edit', habitId: habit.id, values, errors, today });
    const rows = await checkinRows(habit);
    habit.set({ ...toDoc(values), ...counterDoc(values, nums, { habit, rows, today }) });
    await habit.save();
    res.redirect(`/?h=${habit.id}`);
  } catch (err) {
    next(err);
  }
});

// "I got a refill": adds one full refill to what's left now.
router.post('/habits/:id/supply/refill', async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    if (!habit.supply || !habit.supply.enabled) return res.redirect(`/?h=${habit.id}`);
    const today = localToday(req.user.timezone);
    const left = supplyLeft(habit.supply, await checkinRows(habit), today);
    habit.set({
      'supply.base': Math.min(1000000, left + habit.supply.size),
      'supply.baseAt': new Date(),
      'supply.baseDate': today,
      'supply.lowSentFor': undefined,
    });
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
    await Rating.deleteMany({ habitId: habit._id });
    await Habit.deleteOne({ _id: habit._id });
    res.redirect(from === 'settings' ? '/settings?saved=deleted' : '/');
  } catch (err) {
    next(err);
  }
});

// ---------- Pauses ----------
// Planned or after-the-fact breaks. Days inside a pause count as off days.
const PAUSE_MAX_DAYS = 90;

async function renderPauses(req, res, habit, { values, errors = {}, saved = false } = {}) {
  const today = localToday(req.user.timezone);
  const list = [...habit.pauses].sort((a, b) => (a.from < b.from ? 1 : -1)).map((p) => ({
    id: p.id,
    reason: Habit.PAUSE_REASONS[p.reason] || 'Break',
    range: p.from === p.to ? longDate(p.from) : `${longDate(p.from)} – ${longDate(p.to)}`,
    days: daysBetweenInclusive(p.from, p.to),
    when: p.to < today ? 'past' : p.from > today ? 'upcoming' : 'now',
  }));
  res.status(Object.keys(errors).length ? 422 : 200).render('pauses', {
    habit, list, errors, saved, icons, reasons: Habit.PAUSE_REASONS, max: PAUSE_MAX_DAYS,
    values: values || { from: today, to: today, reason: 'travel' },
  });
}

router.get('/habits/:id/pauses', async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    await renderPauses(req, res, habit, { saved: req.query.saved === '1' });
  } catch (err) {
    next(err);
  }
});

router.post('/habits/:id/pauses', async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    const from = String(req.body.from || '');
    const to = String(req.body.to || '');
    const reason = Object.hasOwn(Habit.PAUSE_REASONS, req.body.reason) ? req.body.reason : 'other';
    const errors = {};
    if (!isISODate(from)) errors.from = 'Pick a start date.';
    if (!isISODate(to)) errors.to = 'Pick an end date.';
    if (!errors.from && !errors.to) {
      if (to < from) errors.to = 'The end date is before the start date.';
      else if (daysBetweenInclusive(from, to) > PAUSE_MAX_DAYS) errors.to = `Keep a pause to ${PAUSE_MAX_DAYS} days or fewer.`;
      else {
        const clash = habit.pauses.find((p) => from <= p.to && to >= p.from);
        if (clash) errors.to = `Overlaps your pause ${longDate(clash.from)} – ${longDate(clash.to)}. Remove that one first.`;
      }
    }
    if (Object.keys(errors).length) return renderPauses(req, res, habit, { values: { from, to, reason }, errors });
    habit.pauses.push({ from, to, reason });
    await habit.save();
    res.redirect(`/habits/${habit.id}/pauses?saved=1`);
  } catch (err) {
    next(err);
  }
});

router.post('/habits/:id/pauses/:pauseId/delete', async (req, res, next) => {
  try {
    const habit = await ownHabit(req);
    if (!habit) return res.status(404).send('Habit not found');
    // Rewrite the array (a plain $set) rather than $pull, so it behaves the same on any MongoDB-compatible server.
    const before = habit.pauses.length;
    habit.pauses = habit.pauses.filter((p) => p.id !== req.params.pauseId);
    if (habit.pauses.length === before) return res.status(404).send('Pause not found');
    await habit.save();
    res.redirect(req.body.back === 'home' ? `/?h=${habit.id}` : `/habits/${habit.id}/pauses`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
