// Public pages opened from one-time links: accept a family invite, or reset a password.
const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const AccessToken = require('../models/AccessToken');
const { deleteUserSessions } = require('../lib/sessions');

const router = express.Router();

const linkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).render('link-invalid', { reason: 'Too many attempts. Try again in 15 minutes.' }),
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function signIn(req, res, next, userId) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId.toString();
    req.session.save((err2) => (err2 ? next(err2) : res.redirect('/')));
  });
}

const INVALID = 'This link has expired or was already used. Ask for a new one.';

// ---------- Invite ----------
router.get('/invite/:token', async (req, res, next) => {
  try {
    const invite = await AccessToken.peek('invite', req.params.token);
    if (!invite) return res.status(410).render('link-invalid', { reason: INVALID });
    res.render('invite', { token: req.params.token, values: { name: invite.label || '', email: '' }, errors: {} });
  } catch (err) {
    next(err);
  }
});

router.post('/invite/:token', linkLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirmPassword || '');
    const timezone = validTimezone(req.body.timezone) ? req.body.timezone : 'America/Chicago';

    const errors = {};
    if (!name || name.length > 40) errors.name = 'Enter your name (up to 40 characters).';
    if (!EMAIL.test(email)) errors.email = 'Enter a valid email.';
    else if (await User.exists({ email })) errors.email = 'That email already has an account.';
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    else if (password !== confirm) errors.confirmPassword = 'Passwords don’t match.';
    if (Object.keys(errors).length) {
      if (!(await AccessToken.peek('invite', token))) return res.status(410).render('link-invalid', { reason: INVALID });
      return res.status(422).render('invite', { token, values: { name, email }, errors });
    }

    // Claim the link first: if two people submit it at once, only one wins.
    const invite = await AccessToken.claim('invite', token);
    if (!invite) return res.status(410).render('link-invalid', { reason: INVALID });

    let user;
    try {
      user = await User.create({
        email, name, timezone, role: 'member', invitedBy: invite.createdBy,
        passwordHash: await User.hashPassword(password),
      });
    } catch (err) {
      await AccessToken.updateOne({ _id: invite._id }, { $set: { usedAt: null } }); // give the link back
      if (err.code === 11000) {
        return res.status(422).render('invite', { token, values: { name, email }, errors: { email: 'That email already has an account.' } });
      }
      throw err;
    }
    signIn(req, res, next, user._id);
  } catch (err) {
    next(err);
  }
});

// ---------- Password reset ----------
router.get('/reset/:token', async (req, res, next) => {
  try {
    const reset = await AccessToken.peek('reset', req.params.token);
    const user = reset && (await User.findById(reset.userId));
    if (!user || user.disabled) return res.status(410).render('link-invalid', { reason: INVALID });
    res.render('reset', { token: req.params.token, email: user.email, errors: {} });
  } catch (err) {
    next(err);
  }
});

router.post('/reset/:token', linkLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirmPassword || '');

    const pending = await AccessToken.peek('reset', token);
    const target = pending && (await User.findById(pending.userId));
    if (!target || target.disabled) return res.status(410).render('link-invalid', { reason: INVALID });

    const errors = {};
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    else if (password !== confirm) errors.confirmPassword = 'Passwords don’t match.';
    if (Object.keys(errors).length) return res.status(422).render('reset', { token, email: target.email, errors });

    const reset = await AccessToken.claim('reset', token);
    if (!reset) return res.status(410).render('link-invalid', { reason: INVALID });

    target.passwordHash = await User.hashPassword(password);
    await target.save();
    await deleteUserSessions(target._id); // sign out everywhere, then sign in fresh here
    signIn(req, res, next, target._id);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
