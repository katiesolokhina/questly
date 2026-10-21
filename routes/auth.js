const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');

const router = express.Router();

// 10 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).render('login', { error: 'Too many attempts. Try again in 15 minutes.', email: req.body.email || '' }),
});

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null, email: '' });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = email ? await User.findOne({ email }) : null;
    const ok = user ? await user.verifyPassword(password) : false;

    // Same message either way, so the form doesn't reveal which emails exist.
    if (!ok) return res.status(401).render('login', { error: 'Email or password is incorrect.', email });
    // Only revealed after a correct password, so it can't be used to probe accounts.
    if (user.disabled) {
      return res.status(403).render('login', { error: 'This account is turned off. Ask the person who invited you.', email });
    }

    // New session ID on login prevents session fixation.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user._id.toString();
      req.session.save((err2) => (err2 ? next(err2) : res.redirect('/')));
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('questly.sid');
    res.redirect('/login');
  });
});

module.exports = router;
