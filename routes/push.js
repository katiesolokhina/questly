const express = require('express');
const { requireAuth } = require('../middleware/auth');
const PushSubscription = require('../models/PushSubscription');
const { sendToUser, isPushConfigured } = require('../lib/push');

const router = express.Router();
router.use('/api/push', requireAuth);

// Public VAPID key the browser needs to subscribe.
router.get('/api/push/key', (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Save this device's subscription (idempotent: same endpoint just updates).
router.post('/api/push/subscribe', async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    await PushSubscription.updateOne(
      { endpoint },
      { $set: { userId: req.user._id, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, userAgent: String(req.get('user-agent') || '').slice(0, 200) } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/push/unsubscribe', async (req, res, next) => {
  try {
    await PushSubscription.deleteOne({ endpoint: String((req.body || {}).endpoint || ''), userId: req.user._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// "Send test" button: proves the whole chain works on this device.
router.post('/api/push/test', async (req, res, next) => {
  try {
    const sent = await sendToUser(req.user._id, {
      title: 'Questly',
      body: 'Reminders are working.',
      url: '/',
      tag: 'questly-test',
    });
    res.json({ sent });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
