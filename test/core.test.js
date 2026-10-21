// Core flows: login, check-in, quotes, past days, habits, settings, CSRF.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const User = require('../models/User');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');

const START = '2026-01-01';

test('core flows', async (t) => {
  const today = localToday();
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  let pastDays = 0;

  const app = await startApp({
    name: 'questly_test_core',
    port: 3991,
    async seed() {
      const user = await User.create({ email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword('drops at 9pm') });
      const habit = await Habit.create({ userId: user._id, name: 'Drops', kind: 'medication', icon: 'drop', startDate: START });
      const docs = [];
      for (let d = START; d < today; d = addDays(d, 1)) docs.push({ userId: user._id, habitId: habit._id, date: d, source: 'import' });
      pastDays = docs.length;
      await Checkin.insertMany(docs);
      return { habitId: habit.id };
    },
  });
  t.after(() => app.stop());
  const c = client(app.base);
  const h = app.seeded.habitId;

  await t.test('signs in', async () => {
    const r = await c('/login', { method: 'POST', form: { email: 'katie@test.dev', password: 'drops at 9pm' } });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/');
  });

  await t.test('wrong password is rejected with a generic message', async () => {
    const r = await client(app.base)('/login', { method: 'POST', form: { email: 'katie@test.dev', password: 'nope' } });
    assert.equal(r.status, 401);
    assert.match(r.text, /Email or password is incorrect/);
  });

  await t.test('dashboard shows day count and the check-in button', async () => {
    const r = await c('/');
    assert.match(r.text, new RegExp(`Day ${pastDays + 1}`));
    assert.match(r.text, /btn-checkin/);
  });

  await t.test('check-in shows done card, quote, and bumps the streak', async () => {
    await c(`/habits/${h}/checkin`, { method: 'POST', form: {} });
    const r = await c('/');
    assert.match(r.text, /Done for today/);
    assert.match(r.text, /quote-kicker/);
    assert.match(r.text, new RegExp(`stat-accent">${pastDays + 1}<`));
  });

  await t.test('double check-in is harmless', async () => {
    const r = await c(`/habits/${h}/checkin`, { method: 'POST', form: {} });
    assert.equal(r.status, 302);
    const count = await withDb(app.uri, () => Checkin.countDocuments({ habitId: h, date: today }));
    assert.equal(count, 1);
  });

  await t.test('undo removes today', async () => {
    await c(`/habits/${h}/checkin/undo`, { method: 'POST', form: {} });
    assert.match((await c('/')).text, /btn-checkin/);
  });

  const past = addDays(today, -3);

  await t.test('past day page explains how it was logged', async () => {
    const r = await c(`/habits/${h}/day/${past}`);
    assert.match(r.text, /Imported from your earlier tracking/);
  });

  await t.test('removing a past day breaks the streak', async () => {
    await c(`/habits/${h}/day/${past}`, { method: 'POST', form: { action: 'remove' } });
    assert.match((await c('/')).text, /stat-accent">2</);
  });

  await t.test('re-adding it is marked as added later', async () => {
    await c(`/habits/${h}/day/${past}`, { method: 'POST', form: { action: 'add' } });
    assert.match((await c(`/habits/${h}/day/${past}`)).text, /Added later/);
  });

  await t.test('today and the future are not editable from the day page', async () => {
    assert.equal((await c(`/habits/${h}/day/${today}`, { method: 'POST', form: { action: 'add' } })).status, 400);
    assert.equal((await c(`/habits/${h}/day/${addDays(today, 2)}`, { method: 'POST', form: { action: 'add' } })).status, 400);
  });

  let gym;
  await t.test('creates a weekday habit with a reminder', async () => {
    const r = await c('/habits', { method: 'POST', form: [
      ['name', 'Gym'], ['kind', 'habit'], ['icon', 'dumbbell'], ['schedule', 'specific'],
      ['days', '1'], ['days', '3'], ['days', '5'], ['startDate', START], ['reminderOn', 'on'], ['reminderTime', '07:00'],
    ] });
    gym = (r.location || '').split('h=')[1];
    assert.ok(gym, `expected redirect to new habit, got ${r.status} ${r.location}`);
    const edit = await c(`/habits/${gym}/edit`);
    assert.match(edit.text, /value="07:00"/);
    assert.match(edit.text, /id="reminderOn"[^>]*checked/);
  });

  await t.test('habit form rejects a blank name and no days', async () => {
    const r = await c('/habits', { method: 'POST', form: { name: ' ', schedule: 'specific', startDate: START } });
    assert.equal(r.status, 422);
    assert.match(r.text, /Give it a name/);
    assert.match(r.text, /Pick at least one day/);
  });

  await t.test('archive → listed in settings → restore', async () => {
    await c(`/habits/${gym}/archive`, { method: 'POST', form: {} });
    assert.match((await c('/settings')).text, new RegExp(`/settings/habits/${gym}/restore`));
    await c(`/settings/habits/${gym}/restore`, { method: 'POST', form: {} });
    assert.match((await c('/')).text, /Gym/);
  });

  await t.test('habit with no check-ins deletes with one confirm', async () => {
    assert.equal((await c(`/habits/${gym}/delete`, { method: 'POST', form: {} })).status, 302);
  });

  await t.test('habit with history requires its exact name to delete', async () => {
    assert.equal((await c(`/habits/${h}/delete`, { method: 'POST', form: { confirmName: 'drop' } })).status, 422);
    assert.equal(await withDb(app.uri, () => Habit.countDocuments({ _id: h })), 1);
  });

  await t.test('CSV export: correct type, never cached, contains history', async () => {
    const r = await c('/settings/export.csv');
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.text, /"Drops","Medication"/);
  });

  await t.test('theme preference is saved', async () => {
    await c('/settings/theme', { method: 'POST', form: { theme: 'dark' } });
    assert.match((await c('/settings')).text, /data-theme="dark"/);
  });

  await t.test('password change: wrong current password rejected', async () => {
    const r = await c('/settings/password', { method: 'POST', form: { currentPassword: 'nope', newPassword: 'whatever123', confirmPassword: 'whatever123' } });
    assert.equal(r.status, 422);
  });

  await t.test('password change: works and keeps this device signed in', async () => {
    const other = client(app.base);
    await other('/login', { method: 'POST', form: { email: 'katie@test.dev', password: 'drops at 9pm' } });
    const r = await c('/settings/password', { method: 'POST', form: { currentPassword: 'drops at 9pm', newPassword: 'new phrase 9pm', confirmPassword: 'new phrase 9pm' } });
    assert.equal(r.status, 302);
    assert.equal((await c('/settings?saved=password')).status, 200);
    assert.equal((await other('/')).location, '/login', 'other device should be signed out');
  });

  await t.test('cross-site POSTs are blocked', async () => {
    const r = await c(`/habits/${h}/checkin`, { method: 'POST', form: {}, origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  await t.test('signed-out visitors are sent to login', async () => {
    assert.equal((await client(app.base)('/')).location, '/login');
    assert.equal((await client(app.base)('/settings')).location, '/login');
  });
});
