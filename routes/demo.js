const express = require('express');
const rateLimit = require('express-rate-limit');
const { createDemo } = require('../lib/demo');

const router = express.Router();

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// 5 demo accounts per hour per IP, on top of the global cap in lib/demo.js.
const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login', { error: 'Too many demos from here. Try again in an hour.', email: '' }),
});

// "Try the demo": a POST (so it's same-origin checked and never triggered by a crawler or a link).
router.post('/demo', demoLimiter, async (req, res, next) => {
  try {
    const timezone = validTimezone(req.body.timezone) ? req.body.timezone : 'America/Chicago';
    const user = await createDemo({ timezone });
    if (!user) return res.status(503).render('login', { error: 'The demo is busy right now. Try again later.', email: '' });
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user._id.toString();
      req.session.save((err2) => (err2 ? next(err2) : res.redirect('/')));
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
