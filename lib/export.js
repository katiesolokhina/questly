const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const DayNote = require('../models/DayNote');
const Rating = require('../models/Rating');
const { ratingConfig, defaultsFor } = require('./ratings');
const { addDays, dow, localToday, localTime, DAY_SHORT } = require('./dates');

// CSV-safe cell: quote it, double inner quotes, and neutralize spreadsheet formulas
// (a habit named "=HYPERLINK(...)" must not execute when opened in Excel).
function cell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// One row per habit per day, from each habit's start date through today.
async function buildCsv(user) {
  const today = localToday(user.timezone);
  const habits = await Habit.find({ userId: user._id }).sort({ createdAt: 1 }).lean();
  const rows = [['Habit', 'Type', 'Date', 'Day', 'Status', 'How it was logged', 'Logged at', 'Rating', 'Note']];

  for (const h of habits) {
    const checkins = await Checkin.find({ habitId: h._id }).lean();
    const byDate = new Map(checkins.map((c) => [c.date, c]));
    const notes = new Map((await DayNote.find({ habitId: h._id }).lean()).map((n) => [n.date, n.text]));
    const scores = new Map((await Rating.find({ habitId: h._id }).lean()).map((r) => [r.date, r.score]));
    // Labels even if rating is turned off now, so old scores still read as words.
    const cfg = ratingConfig({ ...h, rating: { ...(h.rating || {}), enabled: true } }) || defaultsFor(h.kind);
    const ratingText = (d) => (scores.has(d) ? `${scores.get(d)} ${cfg.labels[scores.get(d) - 1]}` : '');
    const scheduled = (d) => h.schedule.every || h.schedule.days.includes(dow(d));
    const first = checkins.reduce((min, c) => (c.date < min ? c.date : min), h.startDate);

    for (let d = first; d <= today; d = addDays(d, 1)) {
      const c = byDate.get(d);
      const note = notes.get(d) || '';
      let status;
      if (c) status = 'Done';
      else if (d < h.startDate) { if (!note && !scores.has(d)) continue; status = 'Before start'; }
      else if (h.pauses && h.pauses.some((p) => d >= p.from && d <= p.to)) status = 'Paused';
      else if (!scheduled(d)) status = 'Off day';
      else if (d === today) status = 'Not yet';
      else status = 'Missed';
      const how = !c ? '' : c.source === 'import' ? 'Imported' : c.source === 'backfill' ? 'Added later' : 'On the day';
      const at = c && c.source === 'live' ? localTime(c.checkedInAt, user.timezone) : '';
      rows.push([h.name + (h.archived ? ' (archived)' : ''), h.kind === 'medication' ? 'Medication' : 'Habit', d, DAY_SHORT[dow(d)], status, how, at, ratingText(d), note]);
    }
  }
  // BOM so Excel opens it as UTF-8; CRLF line endings per the CSV spec.
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { buildCsv };
