// Weekly summary rules (no server).
const test = require('node:test');
const assert = require('node:assert/strict');
const Habit = require('../models/Habit');
const { mondayOf, habitWeek, pushText } = require('../lib/weekly');

test('weeks run Monday to Sunday', () => {
  assert.equal(mondayOf('2026-10-19'), '2026-10-19'); // Mon
  assert.equal(mondayOf('2026-10-25'), '2026-10-19'); // Sun
  assert.equal(mondayOf('2026-10-20'), '2026-10-19');
});

test('a Mon/Wed/Fri week: missed, off, bonus and not-yet-done today', () => {
  const h = new Habit({ name: 'Gym', startDate: '2026-01-01', schedule: { every: false, days: [1, 3, 5] } });
  const done = new Set(['2026-10-19', '2026-10-24']); // Mon + bonus Sat
  const w = habitWeek(h, done, '2026-10-19', '2026-10-25'); // as of Sunday
  assert.equal(w.hit, 1);
  assert.equal(w.expected, 3);
  assert.equal(w.extra, 1);
  assert.deepEqual(w.missed, ['Wed', 'Fri']);
  assert.deepEqual(w.days.map((d) => d.status), ['done', 'off', 'missed', 'off', 'missed', 'done', 'off']);
});

test('today not done yet is not counted against you; paused days are excluded', () => {
  const h = new Habit({ name: 'Drops', startDate: '2026-01-01', pauses: [{ from: '2026-10-20', to: '2026-10-21', reason: 'travel' }] });
  const done = new Set(['2026-10-19', '2026-10-22']);
  const w = habitWeek(h, done, '2026-10-19', '2026-10-23');
  assert.equal(w.expected, 2);
  assert.equal(w.hit, 2);
  assert.deepEqual(w.pauses, ['travel']);
  assert.equal(w.days[4].status, 'today');
  assert.equal(w.days[5].status, 'future');
});

test('push wording', () => {
  const week = { hit: 9, expected: 10, rows: [
    { name: 'Quello drops', score: '7/7', perfect: true, streak: 93 },
    { name: 'Gym', score: '2/3', perfect: false, streak: 0 },
  ] };
  assert.deepEqual(pushText(week), { title: 'Your week: 9 of 10 check-ins', body: 'Quello drops 7/7 · streak 93. Gym 2/3. Tap for details.' });
  assert.match(pushText({ ...week, hit: 10 }).title, /^Perfect week/);
});
