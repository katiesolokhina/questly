const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { buildDashboard } = require('../lib/habits');
const icons = require('../lib/icons');

const router = express.Router();

// GET /?h=<habitId>&m=<YYYY-MM>
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const view = await buildDashboard(req.user, String(req.query.h || ''), String(req.query.m || ''));
    res.render('dashboard', { ...view, icons });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
