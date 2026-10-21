// Daily ratings: per-habit question + 5 labels, and the monthly trend.
const D = require('./dates');

const DEFAULTS = {
  medication: { question: 'How are your symptoms today?', labels: ['Clear', 'Mild', 'Moderate', 'Bad', 'Severe'], lowIsGood: true },
  habit: { question: 'How did it go today?', labels: ['Rough', 'Meh', 'Okay', 'Good', 'Great'], lowIsGood: false },
};

function defaultsFor(kind) {
  return DEFAULTS[kind === 'medication' ? 'medication' : 'habit'];
}

// Suggested labels for a direction: the type's labels, flipped if the good end was flipped.
// (Rough → Great with "1 is a good day" becomes Great → Rough.)
function defaultLabels(kind, lowIsGood) {
  const d = defaultsFor(kind);
  return d.lowIsGood === lowIsGood ? d.labels : [...d.labels].reverse();
}

// The habit's rating settings with blanks filled from the suggestions. null when off.
function ratingConfig(habit) {
  const r = habit.rating;
  if (!r || !r.enabled) return null;
  const d = defaultsFor(habit.kind);
  const lowIsGood = r.lowIsGood ?? d.lowIsGood;
  const labels = defaultLabels(habit.kind, lowIsGood).map((fallback, i) => (r.labels && r.labels[i]) || fallback);
  return { question: r.question || d.question, labels, lowIsGood };
}

// 5 = best day, 1 = worst, whichever way the scale runs. Drives colour.
function level(score, lowIsGood) {
  return lowIsGood ? 6 - score : score;
}

function chips(config, current) {
  return config.labels.map((label, i) => ({ score: i + 1, label, level: level(i + 1, config.lowIsGood), on: current === i + 1 }));
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const one = (n) => n.toFixed(1);

/**
 * Month trend. ratings: Map date → score (this month), prevScores: scores from last month.
 * Returns bars for each day shown, the average, and up to two plain-English findings.
 */
function trend(config, { ym, today, startDate, ratings, prevScores, done, counts }) {
  const first = `${ym}-01`;
  const last = D.addDays(`${D.shiftMonth(ym, 1)}-01`, -1);
  const to = last < today ? last : today;
  const from = first > startDate ? first : startDate;
  const bars = [];
  for (let d = first; d <= to; d = D.addDays(d, 1)) {
    const score = d >= from ? ratings.get(d) ?? null : null;
    bars.push({
      date: d,
      day: Number(d.slice(8)),
      score,
      level: score ? level(score, config.lowIsGood) : 0,
      height: score ? score * 20 : 0,
      done: done.has(d),
      title: `${D.longDate(d)}: ${score ? config.labels[score - 1] : 'not rated'}${done.has(d) ? ' · done' : ''}`,
    });
  }

  const scores = bars.filter((b) => b.score).map((b) => b.score);
  const mean = avg(scores);
  const labelOf = (m) => config.labels[Math.min(4, Math.max(0, Math.round(m) - 1))];
  const better = (a, b) => (config.lowIsGood ? a < b : a > b);
  const findings = [];

  const prev = avg(prevScores);
  if (mean !== null && prevScores.length >= 3) {
    const prevName = D.monthLabel(D.shiftMonth(ym, -1)).split(' ')[0];
    if (Math.abs(mean - prev) < 0.1) findings.push(`About the same as ${prevName} (${one(prev)}).`);
    else findings.push(`${better(mean, prev) ? 'Better' : 'Worse'} than ${prevName} (${one(prev)}).`);
  }

  // Done days vs. expected-but-not-done days, when there's enough of each to mean something.
  const onDone = bars.filter((b) => b.score && b.done).map((b) => b.score);
  const onMissed = bars.filter((b) => b.score && !b.done && counts(b.date) && b.date < today).map((b) => b.score);
  if (onDone.length >= 3 && onMissed.length >= 3) {
    findings.push(`Done days averaged ${one(avg(onDone))}, missed days ${one(avg(onMissed))}.`);
  }

  return {
    bars,
    rated: scores.length,
    average: mean === null ? null : one(mean),
    averageLabel: mean === null ? null : labelOf(mean),
    findings,
    best: config.lowIsGood ? `1 ${config.labels[0]}` : `5 ${config.labels[4]}`,
    worst: config.lowIsGood ? `5 ${config.labels[4]}` : `1 ${config.labels[0]}`,
    firstLabel: bars.length ? D.longDate(bars[0].date).split(', ')[1] : '',
    lastLabel: bars.length ? D.longDate(bars[bars.length - 1].date).split(', ')[1] : '',
    summary: mean === null
      ? 'No ratings this month yet.'
      : `${scores.length} day${scores.length === 1 ? '' : 's'} rated, average ${one(mean)} (${labelOf(mean)}).`,
  };
}

module.exports = { DEFAULTS, defaultsFor, defaultLabels, ratingConfig, chips, level, trend };
