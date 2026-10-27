// Timers: duration formatting and goals that count stopwatch minutes (no server).
const test = require('node:test');
const assert = require('node:assert/strict');
const { clock, words } = require('../lib/time');
const { goalView } = require('../lib/counter');

test('clock and words', () => {
  assert.equal(clock(30), '0:30');
  assert.equal(clock(2530), '42:10');
  assert.equal(clock(3723), '1:02:03');
  assert.equal(words(2530), '42 min');
  assert.equal(words(7500), '2 h 05 min');
});

test('a goal by timed minutes sums durations and forecasts from the average session', () => {
  const rows = [
    { date: '2026-10-19', duration: 1800 },
    { date: '2026-10-20', duration: 2400 },
    { date: '2026-10-18' }, // untimed check-in: adds nothing
  ];
  const ctx = { today: '2026-10-20', done: new Set(['2026-10-20']), startDate: '2026-10-01', isScheduled: () => true, isPaused: () => false };
  const g = goalView({ enabled: true, target: 140, by: 'minutes', from: '2026-10-01' }, rows, ctx);
  assert.equal(g.progress, 70);
  assert.equal(g.unit, 'minutes');
  assert.equal(g.pct, 50);
  assert.equal(g.finish, '2026-10-22'); // average 35 min/session → 2 more sessions
});
