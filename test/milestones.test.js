// Milestone math (no server).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/dates');
const M = require('../lib/milestones');

const days = (a, b, skip = () => false) => { const s = new Set(); for (let d = a; d <= b; d = D.addDays(d, 1)) if (!skip(d)) s.add(d); return s; };
const every = () => true;

test('best streak survives a later break', () => {
  const done = days('2026-09-01', '2026-10-20', (d) => d === '2026-10-11');
  assert.equal(M.bestStreak({ done, today: '2026-10-20', startDate: '2026-09-01', isScheduled: every }), 40);
});

test('today not done yet does not break it; paused and off days are skipped', () => {
  const done = days('2026-10-01', '2026-10-19', (d) => d >= '2026-10-05' && d <= '2026-10-07');
  const isPaused = (d) => d >= '2026-10-05' && d <= '2026-10-07';
  assert.equal(M.bestStreak({ done, today: '2026-10-20', startDate: '2026-10-01', isScheduled: every, isPaused }), 16);
  done.add('2026-10-06'); // logged anyway during the pause: a bonus day
  assert.equal(M.bestStreak({ done, today: '2026-10-20', startDate: '2026-10-01', isScheduled: every, isPaused }), 17);
  const mwf = (w) => [1, 3, 5].includes(w);
  const mwfDone = days('2026-10-01', '2026-10-20', (d) => ![1, 3, 5].includes(D.dow(d)));
  assert.equal(M.bestStreak({ done: mwfDone, today: '2026-10-20', startDate: '2026-10-01', isScheduled: mwf }), 8);
});

test('badges: earned levels, the next goal, and names by schedule', () => {
  const b = M.badges(88, true);
  assert.deepEqual(b.earned, [7, 30, 60]);
  assert.equal(b.tiles.length, 6);
  assert.deepEqual(b.next, { level: 100, label: 'Triple digits', toGo: 12 });
  assert.equal(M.badges(88, true, 5).next.toGo, 95, 'a new badge needs the current run to get there');
  assert.equal(M.badges(400, true).tiles.length, 8); // six earned + next two
  assert.equal(M.badges(10, false).tiles[0].label, '7 in a row');
});
