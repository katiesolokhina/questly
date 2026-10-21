// Core flows: login, check-in, quotes, past days, habits, settings, CSRF.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const User = require('../models/User');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const DayNote = require('../models/DayNote');

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

  await t.test('habit details and link show on the dashboard', async () => {
    const r = await c(`/habits/${h}`, { method: 'POST', form: {
      name: 'Drops', kind: 'medication', icon: 'drop', schedule: 'every', startDate: START,
      description: '3 drops under the tongue\nhold 2 minutes', linkUrl: 'quello.com/account', linkLabel: 'My Quello account',
    } });
    assert.equal(r.status, 302);
    const dash = (await c('/')).text;
    assert.match(dash, /3 drops under the tongue/);
    assert.match(dash, /href="https:\/\/quello\.com\/account" target="_blank" rel="noopener noreferrer"/);
    assert.match(dash, /My Quello account/);
  });

  await t.test('javascript: links are rejected', async () => {
    const r = await c(`/habits/${h}`, { method: 'POST', form: { name: 'Drops', schedule: 'every', startDate: START, linkUrl: 'javascript:alert(1)' } });
    assert.equal(r.status, 422);
    assert.match(r.text, /Links must start with https/);
  });

  await t.test('note for today: saved, shown on the dashboard, dot on today', async () => {
    const r = await c(`/habits/${h}/day/${today}/note`, { method: 'POST', form: { note: 'Itchy throat after\nbut fine' } });
    assert.match(r.location, /saved=note/);
    const dash = (await c('/')).text;
    assert.match(dash, /Today's note/);
    assert.match(dash, /Itchy throat after/);
    assert.match(dash, new RegExp(`has-note" href="/habits/${h}/day/${today}`));
  });

  await t.test('notes are escaped, not run as HTML', async () => {
    await c(`/habits/${h}/day/${past}/note`, { method: 'POST', form: { note: '<script>alert(1)</script>' } });
    const page = (await c(`/habits/${h}/day/${past}`)).text;
    assert.doesNotMatch(page, /<script>alert/);
    assert.match(page, /&lt;script&gt;/);
  });

  await t.test('note limits: too long rejected, future rejected, empty deletes', async () => {
    assert.equal((await c(`/habits/${h}/day/${past}/note`, { method: 'POST', form: { note: 'x'.repeat(501) } })).status, 422);
    assert.equal((await c(`/habits/${h}/day/${addDays(today, 1)}/note`, { method: 'POST', form: { note: 'later' } })).status, 400);
    await c(`/habits/${h}/day/${past}/note`, { method: 'POST', form: { note: '   ' } });
    assert.equal(await withDb(app.uri, () => DayNote.countDocuments({ habitId: h, date: past })), 0);
  });

  await t.test('today’s day page offers notes but not check-in changes', async () => {
    const page = (await c(`/habits/${h}/day/${today}`)).text;
    assert.match(page, /name="note"/);
    assert.doesNotMatch(page, /Mark as done|Remove check-in/);
  });

  await t.test('CSV includes notes', async () => {
    assert.match((await c('/settings/export.csv')).text, /Itchy throat after/);
  });

  await t.test('deleting a habit deletes its notes', async () => {
    const r = await c('/habits', { method: 'POST', form: { name: 'Temp', schedule: 'every', startDate: START } });
    const temp = r.location.split('h=')[1];
    await c(`/habits/${temp}/day/${today}/note`, { method: 'POST', form: { note: 'temp note' } });
    await c(`/habits/${temp}/delete`, { method: 'POST', form: {} });
    assert.equal(await withDb(app.uri, () => DayNote.countDocuments({ habitId: temp })), 0);
  });

  await t.test('pause validation: end before start, too long, overlapping', async () => {
    let r = await c(`/habits/${h}/pauses`, { method: 'POST', form: { from: addDays(today, 5), to: addDays(today, 2), reason: 'travel' } });
    assert.equal(r.status, 422);
    r = await c(`/habits/${h}/pauses`, { method: 'POST', form: { from: addDays(today, 1), to: addDays(today, 95), reason: 'travel' } });
    assert.equal(r.status, 422);
    assert.match(r.text, /90 days or fewer/);
    await c(`/habits/${h}/pauses`, { method: 'POST', form: { from: addDays(today, 3), to: addDays(today, 5), reason: 'travel' } });
    r = await c(`/habits/${h}/pauses`, { method: 'POST', form: { from: addDays(today, 5), to: addDays(today, 7), reason: 'sick' } });
    assert.equal(r.status, 422);
    assert.match(r.text, /Overlaps/);
  });

  await t.test('upcoming pause shows a banner and is listed', async () => {
    assert.match((await c('/')).text, /Pause planned · Travel/);
    assert.match((await c(`/habits/${h}/pauses`)).text, /upcoming/);
  });

  await t.test('a pause after the fact repairs the streak for a missed day', async () => {
    const sick = addDays(today, -2);
    await c(`/habits/${h}/day/${sick}`, { method: 'POST', form: { action: 'remove' } });
    assert.match((await c('/')).text, /stat-accent">1</, 'missing yesterday-but-one leaves streak 1');
    const r = await c(`/habits/${h}/pauses`, { method: 'POST', form: { from: sick, to: sick, reason: 'sick' } });
    assert.match(r.location, /saved=1/);
    const dash = (await c('/')).text;
    assert.doesNotMatch(dash, /stat-accent">1</, 'streak should no longer stop at the paused day');
    assert.match((await c(`/habits/${h}/day/${sick}`)).text, /Paused · Sick/);
    assert.match((await c('/settings/export.csv')).text, new RegExp(`"${sick}","\\w+","Paused"`));
  });

  await t.test('paused today: no check-in button, says paused, can still log anyway', async () => {
    await c(`/habits/${h}/pauses`, { method: 'POST', form: { from: today, to: today, reason: 'doctor' } });
    const dash = (await c('/')).text;
    assert.match(dash, /Paused today/);
    assert.doesNotMatch(dash, /btn-checkin/);
    assert.match(dash, /Log anyway/);
  });

  await t.test('removing pauses restores normal behavior', async () => {
    const page = (await c(`/habits/${h}/pauses`)).text;
    const ids = [...page.matchAll(/\/pauses\/([a-f0-9]{24})\/delete/g)].map((m) => m[1]);
    assert.equal(ids.length, 3);
    for (const id of ids) await c(`/habits/${h}/pauses/${id}/delete`, { method: 'POST', form: {} });
    const dash = (await c('/')).text;
    assert.match(dash, /btn-checkin/);
    assert.doesNotMatch(dash, /pause-banner/);
  });

  // ---------- Counters ----------
  const habitForm = (over = {}) => ({ name: 'Bottle', kind: 'medication', icon: 'pill', schedule: 'every', startDate: today, ...over });
  let sup;

  await t.test('supply: validation needs a refill size and whole numbers; javascript: links rejected', async () => {
    let r = await c('/habits', { method: 'POST', form: habitForm({ supplyOn: 'on', supplySize: '', supplyPer: '1', supplyWarn: '7' }) });
    assert.equal(r.status, 422);
    assert.match(r.text, /How much is in a full refill/);
    r = await c('/habits', { method: 'POST', form: habitForm({ supplyOn: 'on', supplySize: '90', supplyLeft: '-3', supplyPer: '1', supplyWarn: '7', supplyUrl: 'javascript:alert(1)' }) });
    assert.equal(r.status, 422);
    assert.match(r.text, /whole number, 0 or more/);
    assert.match(r.text, /Links must start with https/);
  });

  await t.test('supply: card shows what is left; check-in uses one, undo gives it back', async () => {
    const r = await c('/habits', { method: 'POST', form: habitForm({ supplyOn: 'on', supplySize: '90', supplyLeft: '9', supplyPer: '1', supplyUnit: 'doses', supplyWarn: '7', supplyUrl: 'shop.example.com/refill' }) });
    sup = r.location.match(/h=([a-f0-9]{24})/)[1];
    let dash = (await c(`/?h=${sup}`)).text;
    assert.match(dash, /counter-num">9<\/span> doses left/);
    assert.doesNotMatch(dash, /Running low/);
    assert.match(dash, /href="https:\/\/shop\.example\.com\/refill"/);
    await c(`/habits/${sup}/checkin`, { method: 'POST', form: {} });
    dash = (await c(`/?h=${sup}`)).text;
    assert.match(dash, /counter-num">8<\/span>/);
    assert.match(dash, /about <strong>8 days<\/strong>/);
    await c(`/habits/${sup}/checkin/undo`, { method: 'POST', form: {} });
    assert.match((await c(`/?h=${sup}`)).text, /counter-num">9<\/span>/);
  });

  await t.test('supply: editing the amount re-anchors it and flags running low', async () => {
    const edit = (await c(`/habits/${sup}/edit`)).text;
    assert.match(edit, /id="supplyLeft"[^>]*value="9"/);
    await c(`/habits/${sup}`, { method: 'POST', form: habitForm({ supplyOn: 'on', supplySize: '90', supplyLeft: '5', supplyPer: '1', supplyUnit: 'doses', supplyWarn: '7' }) });
    const dash = (await c(`/?h=${sup}`)).text;
    assert.match(dash, /counter-num">5<\/span>/);
    assert.match(dash, /Running low/);
    // Saving again without touching the amount keeps it.
    await c(`/habits/${sup}/checkin`, { method: 'POST', form: {} });
    await c(`/habits/${sup}`, { method: 'POST', form: habitForm({ supplyOn: 'on', supplySize: '90', supplyLeft: '4', supplyPer: '1', supplyUnit: 'doses', supplyWarn: '7' }) });
    assert.match((await c(`/?h=${sup}`)).text, /counter-num">4<\/span>/);
  });

  await t.test('supply: "Add a refill" adds a full refill; a low-alert claim resets', async () => {
    await withDb(app.uri, () => Habit.updateOne({ _id: sup }, { $set: { 'supply.lowSentFor': new Date() } }));
    const r = await c(`/habits/${sup}/supply/refill`, { method: 'POST', form: {} });
    assert.equal(r.status, 302);
    const dash = (await c(`/?h=${sup}`)).text;
    assert.match(dash, /counter-num">94<\/span>/);
    assert.doesNotMatch(dash, /Running low/);
    const doc = await withDb(app.uri, () => Habit.findById(sup).lean());
    assert.equal(doc.supply.lowSentFor, undefined);
    // Today's dose was logged before the refill (old bottle), so undoing it leaves the new count alone.
    await c(`/habits/${sup}/checkin/undo`, { method: 'POST', form: {} });
    assert.match((await c(`/?h=${sup}`)).text, /counter-num">94<\/span>/);
  });

  await t.test('goal: progress, per-check-in amount, and reached', async () => {
    await c(`/habits/${sup}`, { method: 'POST', form: habitForm({ goalOn: 'on', goalLabel: 'Reading', goalTarget: '40', goalUnit: 'pages', goalPer: '20', goalFrom: today }) });
    let dash = (await c(`/?h=${sup}`)).text;
    assert.doesNotMatch(dash, /Supply<\/h2>/, 'supply turned off');
    assert.match(dash, /Reading<\/h2>/);
    assert.match(dash, /counter-num">0<\/span> of 40 pages/);
    await c(`/habits/${sup}/checkin`, { method: 'POST', form: {} });
    dash = (await c(`/?h=${sup}`)).text;
    assert.match(dash, /counter-num">20<\/span> of 40 pages/);
    assert.match(dash, /50% · on pace to finish/);
    await c(`/habits/${sup}`, { method: 'POST', form: habitForm({ goalOn: 'on', goalTarget: '20', goalUnit: 'pages', goalPer: '20', goalFrom: today }) });
    dash = (await c(`/?h=${sup}`)).text;
    assert.match(dash, /Goal reached/);
    assert.match(dash, /Goal<\/h2>/, 'blank name falls back to "Goal"');
  });

  await t.test('goal: validation needs a target', async () => {
    const r = await c(`/habits/${sup}`, { method: 'POST', form: habitForm({ goalOn: 'on', goalTarget: '', goalPer: '1' }) });
    assert.equal(r.status, 422);
    assert.match(r.text, /Set a target/);
  });

  // ---------- Daily rating ----------
  let mood;
  await t.test('rating: habit defaults, rate today, tap again to clear', async () => {
    const r = await c('/habits', { method: 'POST', form: { name: 'Mood', kind: 'habit', icon: 'heart', schedule: 'every', startDate: addDays(today, -5), ratingOn: 'on' } });
    mood = r.location.match(/h=([a-f0-9]{24})/)[1];
    let dash = (await c(`/?h=${mood}`)).text;
    assert.match(dash, /How did it go today\?/);
    assert.match(dash, /rating-label">Great</);
    assert.match(dash, /Rate a day to start your trend/);
    const saved = await c(`/habits/${mood}/day/${today}/rating`, { method: 'POST', form: { score: '4', back: 'home' } });
    assert.equal(saved.location, `/?h=${mood}#rating`);
    dash = (await c(`/?h=${mood}`)).text;
    assert.match(dash, /name="score" value="0" aria-pressed="true"/);
    assert.match(dash, /Avg <strong>4\.0<\/strong> · Good/);
    await c(`/habits/${mood}/day/${today}/rating`, { method: 'POST', form: { score: '0', back: 'home' } });
    assert.doesNotMatch((await c(`/?h=${mood}`)).text, /aria-pressed="true"/);
  });

  await t.test('rating: past days from the day page; future, bad scores and "off" are refused', async () => {
    const past = addDays(today, -2);
    const r = await c(`/habits/${mood}/day/${past}/rating`, { method: 'POST', form: { score: '2' } });
    assert.match(r.location, /saved=rating/);
    assert.match((await c(r.location)).text, /Rating saved/);
    assert.equal((await c(`/habits/${mood}/day/${addDays(today, 1)}/rating`, { method: 'POST', form: { score: '2' } })).status, 400);
    assert.equal((await c(`/habits/${mood}/day/${past}/rating`, { method: 'POST', form: { score: '9' } })).status, 400);
    assert.equal((await c(`/habits/${h}/day/${past}/rating`, { method: 'POST', form: { score: '2' } })).status, 400);
    assert.match((await c('/settings/export.csv')).text, new RegExp(`"Mood","Habit","${past}","\\w+","Missed","","","2 Meh"`));
  });

  await t.test('rating: medication defaults and custom labels', async () => {
    const r = await c('/habits', { method: 'POST', form: { name: 'Allergy', kind: 'medication', icon: 'drop', schedule: 'every', startDate: today, ratingOn: 'on', ratingLabel5: 'Awful' } });
    const id = r.location.match(/h=([a-f0-9]{24})/)[1];
    const dash = (await c(`/?h=${id}`)).text;
    assert.match(dash, /How are your symptoms today\?/);
    assert.match(dash, /rating-label">Clear</);
    assert.match(dash, /rating-label">Awful</);
    assert.match((await c(`/habits/${id}/edit`)).text, /id="ratingDir-low"[^>]*checked/);
    const too = await c(`/habits/${id}`, { method: 'POST', form: { name: 'Allergy', kind: 'medication', schedule: 'every', startDate: today, ratingOn: 'on', ratingLabel1: 'x'.repeat(17) } });
    assert.equal(too.status, 422);
  });

  // ---------- Milestones ----------
  await t.test('milestones: existing badges stay quiet; hitting 7 celebrates once; goal reached celebrates once', async () => {
    await withDb(app.uri, () => Habit.updateOne({ _id: h }, { $set: { 'milestones.enabled': true }, $unset: { 'milestones.seen': 1 } }));
    let dash = (await c(`/?h=${h}`)).text;
    assert.match(dash, /badges-card/);
    assert.doesNotMatch(dash, /<dialog class="celebrate"/, 'badges earned before milestones existed do not pop up');

    const r = await c('/habits', { method: 'POST', form: { name: 'Walk', kind: 'habit', icon: 'leaf', schedule: 'every', startDate: addDays(today, -6), milestonesOn: 'on' } });
    const walk = r.location.match(/h=([a-f0-9]{24})/)[1];
    await withDb(app.uri, async () => {
      const u = await User.findOne({ email: 'katie@test.dev' });
      const docs = [];
      for (let i = 1; i <= 6; i++) docs.push({ userId: u._id, habitId: walk, date: addDays(today, -i), source: 'backfill' });
      await Checkin.insertMany(docs);
    });
    dash = (await c(`/?h=${walk}`)).text;
    assert.match(dash, /1 more in a row to <strong>One week/);
    assert.doesNotMatch(dash, /<dialog class="celebrate"/);

    await c(`/habits/${walk}/checkin`, { method: 'POST', form: {} });
    dash = (await c(`/?h=${walk}`)).text;
    assert.match(dash, /<dialog class="celebrate" open/);
    assert.match(dash, /7 days!/);
    assert.doesNotMatch((await c(`/?h=${walk}`)).text, /<dialog class="celebrate"/, 'shown once');

    await c(`/habits/${walk}`, { method: 'POST', form: { name: 'Walk', kind: 'habit', icon: 'leaf', schedule: 'every', startDate: addDays(today, -6), milestonesOn: 'on', goalOn: 'on', goalLabel: 'Week one', goalTarget: '7', goalUnit: 'walks', goalPer: '1' } });
    dash = (await c(`/?h=${walk}`)).text;
    assert.match(dash, /Goal reached!/);
    assert.match(dash, /Week one done, 7 walks/);
    assert.doesNotMatch((await c(`/?h=${walk}`)).text, /<dialog class="celebrate"/);

    await c(`/habits/${walk}`, { method: 'POST', form: { name: 'Walk', kind: 'habit', icon: 'leaf', schedule: 'every', startDate: addDays(today, -6) } });
    assert.doesNotMatch((await c(`/?h=${walk}`)).text, /badges-card/, 'milestones can be turned off');
  });

  // ---------- Weekly summary ----------
  await t.test('week page: headline, a row per habit, safe navigation', async () => {
    const r = await c('/week');
    assert.equal(r.status, 200);
    assert.match(r.text, /This week/);
    assert.match(r.text, /check-ins|Nothing was due yet/);
    assert.match(r.text, /week-row/);
    assert.match(r.text, /\s+Drops\s+<\/a>/);
    assert.doesNotMatch(r.text, /aria-label="Next week"/, 'no browsing into the future');
    const old = await c(`/week?w=${addDays(today, -14)}`);
    assert.match(old.text, /Your week/);
    assert.match(old.text, /aria-label="Next week"/);
    assert.equal((await c('/week?w=nonsense')).status, 200);
    assert.match((await c('/week?w=2999-01-01')).text, /This week/);
  });

  await t.test('weekly summary can be turned off and on in Settings', async () => {
    assert.match((await c('/settings')).text, /Turn off weekly summary/);
    let r = await c('/settings/weekly', { method: 'POST', form: { weekly: 'off' } });
    assert.match(r.location, /saved=weeklyOff/);
    assert.match((await c('/settings')).text, /Turn on weekly summary/);
    await c('/settings/weekly', { method: 'POST', form: { weekly: 'on' } });
    assert.match((await c('/settings')).text, /Turn off weekly summary/);
  });

  await t.test('habits without counters show no counter cards', async () => {
    assert.doesNotMatch((await c(`/?h=${h}`)).text, /counter-card/);
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
