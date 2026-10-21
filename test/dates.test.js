// Pure date-math rules (no server, runs in milliseconds).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/dates');

const range = (a, b, skip = () => false) => {
  const s = new Set();
  for (let d = a; d <= b; d = D.addDays(d, 1)) if (!skip(d)) s.add(d);
  return s;
};
const everyDay = () => true;
const ym = '2026-10';
const today = '2026-10-20';
const start = '2026-10-01';

test('missed days break the streak and lower adherence', () => {
  const done = range(start, '2026-10-19', (d) => d >= '2026-10-10' && d <= '2026-10-14');
  const s = D.computeStats({ done, today, startDate: start, isScheduled: everyDay, ym });
  assert.equal(s.streak, 5);
  assert.equal(s.adherence, 74); // 14 of 19 elapsed days (today not counted until done)
});

test('the same days paused keep the streak and 100%', () => {
  const done = range(start, '2026-10-19', (d) => d >= '2026-10-10' && d <= '2026-10-14');
  const isPaused = (d) => d >= '2026-10-10' && d <= '2026-10-14';
  const s = D.computeStats({ done, today, startDate: start, isScheduled: everyDay, isPaused, ym });
  assert.equal(s.streak, 14);
  assert.equal(s.adherence, 100);
});

test('a check-in during a pause counts toward total, not streak', () => {
  const isPaused = (d) => d >= '2026-10-10' && d <= '2026-10-14';
  const done = range(start, '2026-10-19', (d) => isPaused(d) && d !== '2026-10-12');
  const s = D.computeStats({ done, today, startDate: start, isScheduled: everyDay, isPaused, ym });
  assert.equal(s.total, 15);
  assert.equal(s.streak, 14);
});

test('paused today: streak counts from today without waiting for a check-in', () => {
  const done = range(start, '2026-10-19');
  const s = D.computeStats({ done, today, startDate: start, isScheduled: everyDay, isPaused: (d) => d === today, ym });
  assert.equal(s.streak, 19);
});

test('off days are skipped, not breaks (Mon/Wed/Fri)', () => {
  const mwf = (dow) => [1, 3, 5].includes(dow);
  const done = range(start, '2026-10-19', (d) => !mwf(D.dow(d)));
  const s = D.computeStats({ done, today, startDate: start, isScheduled: mwf, ym });
  assert.equal(s.adherence, 100);
  assert.ok(s.streak >= 8);
});

test('month grid marks past and planned pauses, but today stays "today"', () => {
  const isPaused = (d) => (d >= '2026-10-10' && d <= '2026-10-14') || (d >= '2026-10-20' && d <= '2026-10-28');
  const cells = D.buildMonth(ym, { done: range(start, '2026-10-09'), today, startDate: start, isScheduled: everyDay, isPaused }).flat().filter((c) => c.inMonth);
  const paused = cells.filter((c) => c.status === 'paused').map((c) => c.day);
  assert.deepEqual(paused, [10, 11, 12, 13, 14, 21, 22, 23, 24, 25, 26, 27, 28]);
  assert.equal(cells[19].status, 'today');
  assert.equal(cells[19].label, 'Today, paused');
});

test('days before the start date are never paused or missed', () => {
  const cells = D.buildMonth(ym, { done: new Set(), today, startDate: '2026-10-15', isScheduled: everyDay, isPaused: () => true }).flat().filter((c) => c.inMonth);
  assert.equal(cells[0].status, 'before-start');
});
