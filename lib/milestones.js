// Streak milestones: badges for the best run ever (so a broken streak never takes a badge away),
// and a one-time celebration the first time each level is reached.
const D = require('./dates');

const LEVELS = [7, 30, 60, 100, 180, 365, 500, 730, 1000];
const NAMES = { 7: 'One week', 30: 'One month', 60: 'Two months', 100: 'Triple digits', 180: 'Six months', 365: 'One year', 500: '500 club', 730: 'Two years', 1000: 'Four digits' };

// Longest run of expected days done, from the start date to today. Same rules as the streak:
// only a missed scheduled day breaks it, bonus check-ins on off/paused days add, today only breaks it once it's over.
function bestStreak({ done, today, startDate, isScheduled, isPaused = () => false }) {
  let run = 0;
  let best = 0;
  for (let d = startDate; d <= today; d = D.addDays(d, 1)) {
    if (done.has(d)) best = Math.max(best, ++run);
    else if (isScheduled(D.dow(d)) && !isPaused(d) && d < today) run = 0;
  }
  return best;
}

function name(level, everyDay) {
  return everyDay ? NAMES[level] : `${level.toLocaleString('en-US')} in a row`;
}

// Tiles: every earned level plus the next two, never fewer than six.
// "To go" counts from the current streak: a new badge needs the current run to get there.
function badges(best, everyDay, current = best) {
  const earned = LEVELS.filter((l) => best >= l);
  const shown = LEVELS.slice(0, Math.max(6, earned.length + 2));
  const next = LEVELS.find((l) => l > best) || null;
  return {
    tiles: shown.map((l) => ({ level: l, label: name(l, everyDay), earned: best >= l })),
    earned,
    best,
    next: next && { level: next, label: name(next, everyDay), toGo: next - current },
  };
}

module.exports = { LEVELS, bestStreak, badges, name };
