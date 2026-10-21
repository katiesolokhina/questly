// Family accounts: invites, privacy, reset links, turn off/on, delete.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const User = require('../models/User');
const Habit = require('../models/Habit');

const linkIn = (html, kind) => (html.match(new RegExp(`value="https?://[^"/]+(/${kind}/[A-Za-z0-9_-]+)"`)) || [])[1];

test('family accounts', async (t) => {
  const app = await startApp({
    name: 'questly_test_family',
    port: 3992,
    async seed() {
      const admin = await User.create({ email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword('drops at 9pm') });
      return { adminId: admin.id };
    },
  });
  t.after(() => app.stop());

  const admin = client(app.base);
  const mom = client(app.base);
  const stranger = client(app.base);
  await admin('/login', { method: 'POST', form: { email: 'katie@test.dev', password: 'drops at 9pm' } });

  let invitePath, momId, momHabit;

  await t.test('admin creates an invite; link is shown exactly once', async () => {
    await admin('/settings/family/invites', { method: 'POST', form: { label: 'Mom' } });
    const first = await admin('/settings');
    invitePath = linkIn(first.text, 'invite');
    assert.ok(invitePath, 'invite link should be shown');
    assert.match(first.text, /Invite link for Mom/);
    const second = await admin('/settings');
    assert.equal(linkIn(second.text, 'invite'), undefined, 'link must not be shown again');
    assert.match(second.text, /Waiting to be used/);
  });

  await t.test('invite form validates input', async () => {
    let r = await stranger(invitePath, { method: 'POST', form: { name: 'Mom', email: 'katie@test.dev', password: 'longenough1', confirmPassword: 'longenough1' } });
    assert.equal(r.status, 422);
    assert.match(r.text, /already has an account/);
    r = await stranger(invitePath, { method: 'POST', form: { name: 'Mom', email: 'mom@test.dev', password: 'short', confirmPassword: 'short' } });
    assert.equal(r.status, 422);
  });

  await t.test('accepting the invite creates a member and signs them in', async () => {
    const r = await mom(invitePath, { method: 'POST', form: { name: 'Mom', email: 'Mom@Test.dev', password: 'mom password', confirmPassword: 'mom password', timezone: 'America/New_York' } });
    assert.equal(r.location, '/');
    assert.match((await mom('/')).text, /No habits yet/);
    const saved = await withDb(app.uri, () => User.findOne({ email: 'mom@test.dev' }).lean());
    assert.equal(saved.role, 'member');
    assert.equal(saved.timezone, 'America/New_York');
    momId = String(saved._id);
  });

  await t.test('used and fake invite links are dead', async () => {
    assert.equal((await stranger(invitePath)).status, 410);
    assert.equal((await stranger('/invite/made-up-token-1234567890')).status, 410);
  });

  await t.test('admin cannot see or touch a member’s habits', async () => {
    const r = await mom('/habits', { method: 'POST', form: { name: 'Vitamins', kind: 'medication', icon: 'pill', schedule: 'every', startDate: '2026-10-01' } });
    momHabit = r.location.split('h=')[1];
    assert.equal((await admin(`/habits/${momHabit}/edit`)).status, 404);
    assert.doesNotMatch((await admin(`/?h=${momHabit}`)).text, /Vitamins/);
    assert.equal((await admin(`/habits/${momHabit}/checkin`, { method: 'POST', form: {} })).status, 404);
    assert.equal((await admin(`/habits/${momHabit}/day/2026-10-02`)).status, 404);
    // Notes can hold symptoms: the admin must not be able to read or write them either.
    await mom(`/habits/${momHabit}/day/2026-10-02/note`, { method: 'POST', form: { note: 'private symptom' } });
    assert.equal((await admin(`/habits/${momHabit}/day/2026-10-02/note`, { method: 'POST', form: { note: 'x' } })).status, 404);
    assert.doesNotMatch((await admin('/settings/export.csv')).text, /private symptom/);
  });

  await t.test('members have no admin powers', async () => {
    assert.doesNotMatch((await mom('/settings')).text, /id="family"/);
    assert.equal((await mom('/settings/family/invites', { method: 'POST', form: { label: 'x' } })).status, 404);
    assert.equal((await mom(`/settings/family/members/${app.seeded.adminId}/disable`, { method: 'POST', form: {} })).status, 404);
  });

  await t.test('reset link: new password works, other devices signed out, link single-use', async () => {
    await admin(`/settings/family/members/${momId}/reset`, { method: 'POST', form: {} });
    const resetPath = linkIn((await admin('/settings')).text, 'reset');
    assert.ok(resetPath);
    const phone = client(app.base);
    assert.match((await phone(resetPath)).text, /mom@test\.dev/);
    assert.equal((await phone(resetPath, { method: 'POST', form: { password: 'new mom pass', confirmPassword: 'new mom pass' } })).status, 302);
    assert.equal((await mom('/')).location, '/login', 'old session should be gone');
    assert.equal((await phone(resetPath)).status, 410);
    assert.equal((await mom('/login', { method: 'POST', form: { email: 'mom@test.dev', password: 'mom password' } })).status, 401);
    assert.equal((await mom('/login', { method: 'POST', form: { email: 'mom@test.dev', password: 'new mom pass' } })).status, 302);
  });

  await t.test('turn off: signed out now, can’t sign in, data kept; turn on restores', async () => {
    await admin(`/settings/family/members/${momId}/disable`, { method: 'POST', form: {} });
    assert.equal((await mom('/')).location, '/login');
    let r = await mom('/login', { method: 'POST', form: { email: 'mom@test.dev', password: 'new mom pass' } });
    assert.equal(r.status, 403);
    r = await mom('/login', { method: 'POST', form: { email: 'mom@test.dev', password: 'wrong guess' } });
    assert.equal(r.status, 401, 'a wrong password must not reveal the account is off');
    assert.doesNotMatch(r.text, /turned off/);
    await admin(`/settings/family/members/${momId}/enable`, { method: 'POST', form: {} });
    assert.equal((await mom('/login', { method: 'POST', form: { email: 'mom@test.dev', password: 'new mom pass' } })).status, 302);
    assert.match((await mom(`/?h=${momHabit}`)).text, /Vitamins/);
  });

  await t.test('admin can’t turn off or delete their own account', async () => {
    assert.equal((await admin(`/settings/family/members/${app.seeded.adminId}/disable`, { method: 'POST', form: {} })).status, 404);
    assert.equal((await admin(`/settings/family/members/${app.seeded.adminId}/delete`, { method: 'POST', form: { confirmEmail: 'katie@test.dev' } })).status, 404);
  });

  await t.test('delete account needs the exact email, then erases everything', async () => {
    assert.equal((await admin(`/settings/family/members/${momId}/delete`, { method: 'POST', form: { confirmEmail: 'mom' } })).status, 422);
    assert.equal((await admin(`/settings/family/members/${momId}/delete`, { method: 'POST', form: { confirmEmail: ' MOM@test.dev ' } })).status, 302);
    assert.equal((await mom('/')).location, '/login');
    assert.equal((await mom('/login', { method: 'POST', form: { email: 'mom@test.dev', password: 'new mom pass' } })).status, 401);
    assert.equal(await withDb(app.uri, () => Habit.countDocuments({ _id: momHabit })), 0);
  });

  await t.test('cancelled invites stop working', async () => {
    await admin('/settings/family/invites', { method: 'POST', form: { label: 'Dad' } });
    const html = (await admin('/settings')).text;
    const dadPath = linkIn(html, 'invite');
    const inviteId = (html.match(/\/settings\/family\/invites\/([a-f0-9]{24})\/revoke/) || [])[1];
    await admin(`/settings/family/invites/${inviteId}/revoke`, { method: 'POST', form: {} });
    assert.equal((await stranger(dadPath)).status, 410);
  });
});
