const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const Habit = require('../models/Habit');
const AccessToken = require('../models/AccessToken');
const icons = require('../lib/icons');
const { buildCsv } = require('../lib/export');
const { localToday } = require('../lib/dates');

const router = express.Router();
router.use('/settings', requireAuth);

const SAVED = {
  password: 'Password changed. Other devices have been signed out.',
  theme: 'Appearance saved.',
  restored: 'Habit restored.',
  deleted: 'Habit deleted.',
  revoked: 'Invite cancelled.',
  disabled: 'Account turned off. They’ve been signed out everywhere.',
  enabled: 'Account turned back on.',
  removed: 'Account deleted.',
};

async function renderSettings(req, res, extra = {}) {
  const archived = await Habit.find({ userId: req.user._id, archived: true }).sort({ updatedAt: -1 }).lean();

  // Family section (admin only): accounts and open invites, never anyone's habits.
  let family = null;
  if (req.user.role === 'admin') {
    const [members, invites] = await Promise.all([
      User.find({ _id: { $ne: req.user._id } }, { name: 1, email: 1, disabled: 1, createdAt: 1 }).sort({ createdAt: 1 }).lean(),
      AccessToken.find({ kind: 'invite', usedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean(),
    ]);
    family = { members, invites, link: req.session.flashLink || null };
    delete req.session.flashLink; // a new link is shown exactly once
  }

  res.status(extra.status || 200).render('settings', {
    archived,
    family,
    icons,
    saved: Object.hasOwn(SAVED, req.query.saved || '') ? SAVED[req.query.saved] : null,
    pwErrors: {},
    ...extra,
  });
}

router.get('/settings', async (req, res, next) => {
  try {
    await renderSettings(req, res);
  } catch (err) {
    next(err);
  }
});

// ---------- Change password ----------
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) =>
    renderSettings(req, res, { status: 429, pwErrors: { form: 'Too many attempts. Try again in 15 minutes.' } }).catch(next),
});

router.post('/settings/password', passwordLimiter, async (req, res, next) => {
  try {
    const current = String(req.body.currentPassword || '');
    const next1 = String(req.body.newPassword || '');
    const next2 = String(req.body.confirmPassword || '');
    const errors = {};

    const user = await User.findById(req.user._id);
    if (!(await user.verifyPassword(current))) errors.currentPassword = 'That isn’t your current password.';
    if (next1.length < 8) errors.newPassword = 'Use at least 8 characters.';
    else if (next1 === current) errors.newPassword = 'Pick a password different from your current one.';
    if (!errors.newPassword && next1 !== next2) errors.confirmPassword = 'Passwords don’t match.';
    if (Object.keys(errors).length) return renderSettings(req, res, { status: 422, pwErrors: errors });

    user.passwordHash = await User.hashPassword(next1);
    await user.save();

    // Sign out every other device: delete this user's other sessions from the store.
    // connect-mongo stores each session as a JSON string containing "userId":"<id>".
    await mongoose.connection.collection('sessions').deleteMany({
      _id: { $ne: req.sessionID },
      session: { $regex: `"userId":"${user._id.toString()}"` },
    });

    // Fresh session id for this device too.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user._id.toString();
      req.session.save((err2) => (err2 ? next(err2) : res.redirect('/settings?saved=password')));
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Appearance ----------
router.post('/settings/theme', async (req, res, next) => {
  try {
    const theme = ['system', 'light', 'dark'].includes(req.body.theme) ? req.body.theme : 'system';
    await User.updateOne({ _id: req.user._id }, { $set: { theme } });
    res.redirect('/settings?saved=theme');
  } catch (err) {
    next(err);
  }
});

// ---------- Archived habits ----------
router.post('/settings/habits/:id/restore', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Habit not found');
    const result = await Habit.updateOne(
      { _id: req.params.id, userId: req.user._id, archived: true },
      { $set: { archived: false } }
    );
    if (!result.matchedCount) return res.status(404).send('Habit not found');
    res.redirect('/settings?saved=restored');
  } catch (err) {
    next(err);
  }
});

// ---------- Export ----------
router.get('/settings/export.csv', async (req, res, next) => {
  try {
    const csv = await buildCsv(req.user);
    const filename = `questly-export-${localToday(req.user.timezone)}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store', // personal health data: never cache
    });
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
