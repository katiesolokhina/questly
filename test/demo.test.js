// "Try the demo": private throwaway accounts with sample data, no external APIs, no account changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp, client, withDb } = require('./helpers');
const User = require('../models/User');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const Rating = require('../models/Rating');
const { cleanupDemos } = require('../lib/demo');

test('demo accounts', async (t) => {
  // A fake Google: if a demo account ever calls the Pollen API, this counter shows it.
  let googleHits = 0;
  const stub = http.createServer((req, res) => { googleHits++; res.setHeader('content-type', 'application/json'); res.end('{}'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));

  const app = await startApp({
    name: 'questly_test_demo',
    port: 3994,
    env: { DEMO_MAX: '3', POLLEN_API_KEY: 'stub-key', POLLEN_API_BASE: `http://127.0.0.1:${stub.address().port}` },
    async seed() {
      await User.create({ email: 'admin@test.dev', name: 'Admin', role: 'admin', passwordHash: await User.hashPassword('admin pass 1') });
    },
  });
  t.after(async () => { await app.stop(); stub.close(); });

  const demo = client(app.base);
  let demoId;

  await t.test('login page offers the demo; it signs you straight into your own copy', async () => {
    assert.match((await client(app.base)('/login')).text, /Try the demo/);
    const r = await demo('/demo', { method: 'POST', form: { timezone: 'America/New_York' } });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/');
    const u = await withDb(app.uri, () => User.findOne({ demo: true }).lean());
    demoId = u._id;
    assert.equal(u.timezone, 'America/New_York');
    assert.ok(u.demoExpiresAt > new Date(Date.now() + 23 * 3600 * 1000));
    assert.equal(u.role, 'member');
  });

  await t.test('sample data shows every feature', async () => {
    const dash = (await demo('/')).text;
    assert.match(dash, /demo-banner/);
    assert.match(dash, /Allergy drops/);
    assert.match(dash, /Gym/);
    assert.match(dash, /Read/);
    assert.match(dash, /Running low/);
    assert.match(dash, /3-year course/);
    assert.match(dash, /Pollen today · Sample city/);
    assert.match(dash, /class="trend-pollen"/);
    assert.match(dash, /badges-card/);
    assert.match(dash, /<dialog class="celebrate" open/, 'a milestone celebration on first look');
    assert.match(dash, /30 days!/);
    assert.equal(googleHits, 0, 'demo never calls Google');
    const counts = await withDb(app.uri, async () => ({
      habits: await Habit.countDocuments({ userId: demoId }),
      checkins: await Checkin.countDocuments({ userId: demoId }),
      ratings: await Rating.countDocuments({ userId: demoId }),
    }));
    assert.equal(counts.habits, 3);
    assert.ok(counts.checkins > 100);
    assert.ok(counts.ratings > 40);
  });

  await t.test('the demo can use the app normally', async () => {
    const h = (await demo('/')).text.match(/\/habits\/([a-f0-9]{24})\/checkin"/)[1];
    await demo(`/habits/${h}/checkin`, { method: 'POST', form: {} });
    const dash = (await demo('/')).text;
    assert.match(dash, /Done for today/);
    assert.match(dash, /quote-kicker/);
    assert.equal((await demo('/week')).status, 200);
    assert.equal((await demo('/settings/export.csv')).status, 200);
  });

  await t.test('no password changes, no pollen location, no push', async () => {
    const settings = (await demo('/settings')).text;
    assert.doesNotMatch(settings, /Change password/);
    assert.match(settings, /You're in the demo/);
    assert.match(settings, /sample pollen data/);
    let r = await demo('/settings/password', { method: 'POST', form: { currentPassword: 'x', newPassword: 'new password 1', confirmPassword: 'new password 1' } });
    assert.equal(r.status, 403);
    r = await demo('/settings/pollen', { method: 'POST', form: { place: 'Dallas, TX' } });
    assert.equal(r.status, 403);
    assert.equal((await demo('/api/push/key')).status, 403);
    r = await demo('/api/push/subscribe', { method: 'POST', form: { endpoint: 'https://push.example/x' } });
    assert.equal(r.status, 403);
  });

  await t.test('demo accounts never show up in the admin’s family list', async () => {
    const admin = client(app.base);
    await admin('/login', { method: 'POST', form: { email: 'admin@test.dev', password: 'admin pass 1' } });
    const s = (await admin('/settings')).text;
    assert.doesNotMatch(s, /demo-[a-f0-9]+@demo\.invalid/);
    assert.equal((await admin(`/settings/family/members/${demoId}/disable`, { method: 'POST', form: {} })).status, 404);
  });

  await t.test('cross-site POSTs cannot create demos', async () => {
    const r = await client(app.base)('/demo', { method: 'POST', form: {}, origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  await t.test('a cap on demos alive at once, and a per-IP rate limit', async () => {
    await client(app.base)('/demo', { method: 'POST', form: {} });
    await client(app.base)('/demo', { method: 'POST', form: {} }); // 3 alive = DEMO_MAX
    let r = await client(app.base)('/demo', { method: 'POST', form: {} });
    assert.equal(r.status, 503);
    assert.match(r.text, /busy/);
    r = await client(app.base)('/demo', { method: 'POST', form: {} }); // 5th try this hour: still allowed (and still busy)
    assert.equal(r.status, 503);
    r = await client(app.base)('/demo', { method: 'POST', form: {} }); // 6th: rate limited
    assert.equal(r.status, 429);
  });

  await t.test('expired demos are deleted with everything they own, and signed out', async () => {
    const deleted = await withDb(app.uri, async () => {
      await User.updateOne({ _id: demoId }, { $set: { demoExpiresAt: new Date(Date.now() - 1000) } });
      const n = await cleanupDemos();
      return {
        n,
        user: await User.exists({ _id: demoId }),
        habits: await Habit.countDocuments({ userId: demoId }),
        checkins: await Checkin.countDocuments({ userId: demoId }),
        ratings: await Rating.countDocuments({ userId: demoId }),
        others: await User.countDocuments({ demo: true }),
      };
    });
    assert.equal(deleted.n, 1);
    assert.equal(deleted.user, null);
    assert.equal(deleted.habits + deleted.checkins + deleted.ratings, 0);
    assert.equal(deleted.others, 2, 'unexpired demos are kept');
    assert.equal((await demo('/')).location, '/login');
  });
});
