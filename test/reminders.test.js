// "Running low" supply alerts: sent once per refill, only during the day.
// Runs the reminder tick in-process at fixed times (push itself is off in tests,
// so this checks the decision and the once-only claim, not delivery).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDatabase } = require('./helpers');
const User = require('../models/User');
const Habit = require('../models/Habit');
const { tick, supplyMessage } = require('../lib/reminders');

const at = (local) => new Date(`${local}-05:00`); // America/Chicago in October (CDT)

test('supply alerts', async (t) => {
  const db = await startDatabase('questly_test_reminders');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });

  const user = await User.create({ email: 'r@test.dev', name: 'R', role: 'admin', passwordHash: 'x', timezone: 'America/Chicago' });
  const baseAt = at('2026-10-20T08:00:00');
  const make = (name, base) => Habit.create({
    userId: user._id, name, kind: 'medication', startDate: '2026-10-01',
    supply: { enabled: true, unit: 'doses', perCheckin: 1, size: 90, base, baseAt, baseDate: '2026-10-20', warnDays: 7 },
  });
  const low = await make('Low', 3);
  const fine = await make('Fine', 60);
  const sentFor = async (h) => (await Habit.findById(h._id).lean()).supply.lowSentFor;

  await t.test('quiet before 9 AM', async () => {
    await tick(at('2026-10-20T08:30:00'));
    assert.equal(await sentFor(low), undefined);
  });

  await t.test('claimed at 9 AM for a low supply, never for a full one', async () => {
    await tick(at('2026-10-20T09:00:00'));
    assert.equal((await sentFor(low)).getTime(), baseAt.getTime());
    assert.equal(await sentFor(fine), undefined);
  });

  await t.test('a refill re-arms it; quiet after 9 PM', async () => {
    await Habit.updateOne({ _id: low._id }, { $set: { 'supply.baseAt': at('2026-10-20T21:30:00'), 'supply.base': 2 }, $unset: { 'supply.lowSentFor': 1 } });
    await tick(at('2026-10-20T21:30:00'));
    assert.equal(await sentFor(low), undefined);
    await tick(at('2026-10-21T09:05:00'));
    assert.ok(await sentFor(low));
  });

  await t.test('weekly summary: Sundays 7–8 PM only, once, and never when turned off', async () => {
    const sent = async () => (await User.findById(user._id).lean()).weeklySentFor;
    await tick(at('2026-10-24T19:10:00')); // Saturday
    assert.equal(await sent(), undefined);
    await tick(at('2026-10-25T18:59:00'));
    assert.equal(await sent(), undefined);
    await tick(at('2026-10-25T19:00:00'));
    assert.equal(await sent(), '2026-10-25');
    const quiet = await User.create({ email: 'q@test.dev', name: 'Q', role: 'member', passwordHash: 'x', weeklySummary: false });
    await tick(at('2026-11-01T20:05:00')); // = 7:05 PM CST: clocks fell back that morning
    assert.equal(await sent(), '2026-11-01');
    assert.equal((await User.findById(quiet._id).lean()).weeklySentFor, undefined);
  });

  await t.test('wording', () => {
    assert.equal(supplyMessage({ out: false, daysLeft: 1, unit: 'doses' }), 'About 1 day of doses left. Time to reorder.');
    assert.match(supplyMessage({ out: true, unit: 'doses' }), /out of doses/);
  });
});
