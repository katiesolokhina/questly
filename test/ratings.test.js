// Daily rating settings and the monthly trend (no server).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/ratings');

test('defaults follow the habit type; custom labels override one at a time', () => {
  const med = R.ratingConfig({ kind: 'medication', rating: { enabled: true } });
  assert.equal(med.question, 'How are your symptoms today?');
  assert.deepEqual(med.labels, ['Clear', 'Mild', 'Moderate', 'Bad', 'Severe']);
  assert.equal(med.lowIsGood, true);
  const custom = R.ratingConfig({ kind: 'habit', rating: { enabled: true, question: 'Energy?', labels: ['', 'Low', '', '', ''], lowIsGood: false } });
  assert.deepEqual(custom.labels, ['Rough', 'Low', 'Okay', 'Good', 'Great']);
  assert.equal(R.ratingConfig({ kind: 'habit', rating: { enabled: false } }), null);
});

test('colour level runs best→worst either way', () => {
  assert.equal(R.level(1, true), 5);
  assert.equal(R.level(5, true), 1);
  assert.equal(R.level(5, false), 5);
});

const cfgMed = R.ratingConfig({ kind: 'medication', rating: { enabled: true } });
const base = { ym: '2026-10', today: '2026-10-10', startDate: '2026-01-01', counts: () => true };

test('trend: one bar per day up to today, average with its label', () => {
  const ratings = new Map([['2026-10-01', 2], ['2026-10-02', 3], ['2026-10-10', 1]]);
  const t = R.trend(cfgMed, { ...base, ratings, prevScores: [], done: new Set() });
  assert.equal(t.bars.length, 10);
  assert.equal(t.rated, 3);
  assert.equal(t.average, '2.0');
  assert.equal(t.averageLabel, 'Mild');
  assert.equal(t.bars[3].score, null);
  assert.deepEqual(t.findings, []); // too little to compare
});

test('trend: compares with last month in the right direction', () => {
  const ratings = new Map([['2026-10-01', 2], ['2026-10-02', 2]]);
  const t = R.trend(cfgMed, { ...base, ratings, prevScores: [3, 3, 3], done: new Set() });
  assert.deepEqual(t.findings, ['Better than September (3.0).']); // lower symptoms = better
  const mood = R.ratingConfig({ kind: 'habit', rating: { enabled: true } });
  assert.deepEqual(R.trend(mood, { ...base, ratings, prevScores: [3, 3, 3], done: new Set() }).findings, ['Worse than September (3.0).']);
});

test('trend: done days vs missed days, when there are 3+ of each', () => {
  const ratings = new Map([['2026-10-01', 1], ['2026-10-02', 2], ['2026-10-03', 1], ['2026-10-04', 4], ['2026-10-05', 3], ['2026-10-06', 4]]);
  const done = new Set(['2026-10-01', '2026-10-02', '2026-10-03']);
  const t = R.trend(cfgMed, { ...base, ratings, prevScores: [], done });
  assert.deepEqual(t.findings, ['Done days averaged 1.3, missed days 3.7.']);
});

test('trend: days before the habit started are blank', () => {
  const t = R.trend(cfgMed, { ...base, startDate: '2026-10-05', ratings: new Map([['2026-10-02', 3]]), prevScores: [], done: new Set() });
  assert.equal(t.rated, 0);
  assert.equal(t.average, null);
});
