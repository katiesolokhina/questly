// Supply countdown and goal math (no server).
const test = require('node:test');
const assert = require('node:assert/strict');
const { supplyView, supplyLeft, goalView } = require('../lib/counter');

const today = '2026-10-20'; // a Tuesday
const everyDay = () => true;
const mwf = (d) => [1, 3, 5].includes(d);
const ctx = (over = {}) => ({ today, done: new Set(), startDate: '2026-01-01', isScheduled: everyDay, isPaused: () => false, ...over });
const at = (date, hh = 12) => ({ date, checkedInAt: new Date(`${date}T${String(hh).padStart(2, '0')}:00:00Z`) });
const supply = (over = {}) => ({ enabled: true, unit: 'doses', perCheckin: 1, size: 90, base: 9, baseDate: '2026-10-18', baseAt: new Date('2026-10-18T15:00:00Z'), warnDays: 7, ...over });

test('supply: check-ins since the refill are used; earlier ones and same-day-before are not', () => {
  const rows = [at('2026-10-17'), at('2026-10-18', 10), at('2026-10-19'), at('2026-10-20')];
  const v = supplyView(supply(), rows, ctx({ done: new Set(rows.map((r) => r.date)) }));
  assert.equal(v.left, 7); // 9 minus Oct 19 and Oct 20; the Oct 18 10:00 dose came before the 15:00 refill
});

test('supply: daily habit, 7 left, today not done → lasts 7 days, low at warnDays 7', () => {
  const v = supplyView(supply({ base: 7, baseDate: today, baseAt: new Date(`${today}T00:00:00Z`) }), [], ctx());
  assert.equal(v.daysLeft, 7);
  assert.equal(v.runsOut, '2026-10-27');
  assert.equal(v.low, true);
  assert.equal(supplyView(supply({ base: 9, baseDate: today, baseAt: new Date(`${today}T00:00:00Z`) }), [], ctx()).low, false);
});

test('supply: Mon/Wed/Fri habit stretches 3 doses to the next Monday', () => {
  const v = supplyView(supply({ base: 3, baseDate: today, baseAt: new Date(`${today}T00:00:00Z`) }), [], ctx({ isScheduled: mwf }));
  assert.equal(v.checkinsLeft, 3); // Wed 21, Fri 23, Mon 26
  assert.equal(v.runsOut, '2026-10-28'); // the Wednesday after
});

test('supply: a planned pause pushes the run-out date out', () => {
  const s = supply({ base: 5, baseDate: today, baseAt: new Date(`${today}T00:00:00Z`) });
  const plain = supplyView(s, [], ctx());
  const paused = supplyView(s, [], ctx({ isPaused: (d) => d >= '2026-10-22' && d <= '2026-10-25' }));
  assert.equal(plain.runsOut, '2026-10-25');
  assert.equal(paused.runsOut, '2026-10-29');
});

test('supply: empty is "out" and low; never negative', () => {
  const rows = [at('2026-10-19'), at('2026-10-20')];
  const v = supplyView(supply({ base: 1 }), rows, ctx({ done: new Set(rows.map((r) => r.date)) }));
  assert.equal(v.left, 0);
  assert.equal(v.out, true);
  assert.equal(v.low, true);
});

test('supply: 2 per check-in, and supplyLeft matches the card', () => {
  const rows = [at('2026-10-19'), at('2026-10-20')];
  const s = supply({ base: 10, perCheckin: 2 });
  assert.equal(supplyView(s, rows, ctx({ done: new Set(rows.map((r) => r.date)) })).left, 6);
  assert.equal(supplyLeft(s, rows, today), 6);
});

test('goal: counts check-ins since "from" times the amount, and forecasts the finish', () => {
  const rows = [at('2026-09-30'), at('2026-10-01'), at('2026-10-19'), at('2026-10-20')];
  const g = goalView({ enabled: true, target: 100, perCheckin: 20, unit: 'pages', from: '2026-10-01' }, rows, ctx({ done: new Set(rows.map((r) => r.date)) }));
  assert.equal(g.progress, 60);
  assert.equal(g.pct, 60);
  assert.equal(g.finish, '2026-10-22'); // 2 more check-ins: Oct 21, Oct 22
  assert.equal(g.reached, false);
});

test('goal: reached at or past the target, with no forecast', () => {
  const rows = [at('2026-10-19'), at('2026-10-20')];
  const g = goalView({ enabled: true, target: 2, perCheckin: 1, from: '2026-01-01' }, rows, ctx());
  assert.equal(g.reached, true);
  assert.equal(g.finish, null);
  assert.equal(g.pct, 100);
});

test('goal: far-off finish shows its year', () => {
  const g = goalView({ enabled: true, target: 1095, perCheckin: 1, from: '2026-07-25' }, [at('2026-10-20')], ctx({ done: new Set([today]) }));
  assert.match(g.finishLabel, /, 2029$/);
});

test('turned off → nothing to show', () => {
  assert.equal(supplyView({ enabled: false }, [], ctx()), null);
  assert.equal(goalView({ enabled: false, target: 5 }, [], ctx()), null);
});
