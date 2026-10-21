// Admin-only account management. Admin never sees other people's habits or check-ins.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const User = require('../models/User');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const ReminderLog = require('../models/ReminderLog');
const DailyMessage = require('../models/DailyMessage');
const PushSubscription = require('../models/PushSubscription');
const AccessToken = require('../models/AccessToken');
const { deleteUserSessions } = require('../lib/sessions');

const router = express.Router();
router.use('/settings/family', requireAuth, requireAdmin);

const INVITE_DAYS = 7;
const RESET_DAYS = 1;

function linkFor(kind, raw) {
  return `${process.env.APP_ORIGIN}/${kind}/${raw}`;
}

// Another account (never yourself) that this admin may manage.
async function member(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  if (req.params.id === req.user.id) return null;
  return User.findById(req.params.id);
}

// ---------- Invites ----------
router.post('/settings/family/invites', async (req, res, next) => {
  try {
    const label = String(req.body.label || '').trim().slice(0, 40);
    const { raw } = await AccessToken.issue({ kind: 'invite', createdBy: req.user._id, label, days: INVITE_DAYS });
    // Shown once on the next page load; only its hash is stored.
    req.session.flashLink = { kind: 'invite', url: linkFor('invite', raw), label, days: INVITE_DAYS };
    res.redirect('/settings#family');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/family/invites/:id/revoke', async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      await AccessToken.deleteOne({ _id: req.params.id, kind: 'invite', usedAt: null });
    }
    res.redirect('/settings?saved=revoked#family');
  } catch (err) {
    next(err);
  }
});

// ---------- Members ----------
router.post('/settings/family/members/:id/reset', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    await AccessToken.deleteMany({ kind: 'reset', userId: target._id, usedAt: null }); // only the newest link works
    const { raw } = await AccessToken.issue({ kind: 'reset', createdBy: req.user._id, userId: target._id, days: RESET_DAYS });
    req.session.flashLink = { kind: 'reset', url: linkFor('reset', raw), label: target.name, days: RESET_DAYS };
    res.redirect('/settings#family');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/family/members/:id/disable', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    target.disabled = true;
    await target.save();
    await deleteUserSessions(target._id); // signed out on every device right away
    await AccessToken.deleteMany({ kind: 'reset', userId: target._id });
    res.redirect('/settings?saved=disabled#family');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/family/members/:id/enable', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    target.disabled = false;
    await target.save();
    res.redirect('/settings?saved=enabled#family');
  } catch (err) {
    next(err);
  }
});

// ---------- Delete account (permanent) ----------
router.get('/settings/family/members/:id/delete', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    const habitCount = await Habit.countDocuments({ userId: target._id });
    res.render('member-delete', { target, habitCount, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/family/members/:id/delete', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    if (String(req.body.confirmEmail || '').trim().toLowerCase() !== target.email) {
      const habitCount = await Habit.countDocuments({ userId: target._id });
      return res.status(422).render('member-delete', { target, habitCount, error: `Type ${target.email} exactly to confirm.` });
    }
    const habitIds = (await Habit.find({ userId: target._id }, { _id: 1 }).lean()).map((h) => h._id);
    await Promise.all([
      Checkin.deleteMany({ userId: target._id }),
      ReminderLog.deleteMany({ habitId: { $in: habitIds } }),
      Habit.deleteMany({ userId: target._id }),
      DailyMessage.deleteMany({ userId: target._id }),
      PushSubscription.deleteMany({ userId: target._id }),
      AccessToken.deleteMany({ userId: target._id }),
      deleteUserSessions(target._id),
    ]);
    await User.deleteOne({ _id: target._id });
    res.redirect('/settings?saved=removed#family');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
