// Demo accounts: "Try the demo" creates a private, throwaway account filled with sample data.
// Each visitor gets their own copy (nobody can mess up the demo for the next person),
// and copies delete themselves after DEMO_HOURS.
//
// Demo accounts never touch paid or external services: no API Ninjas (built-in quotes),
// no Google Pollen (sample pollen stored under a fake place), no push. They can't change
// a password, set a pollen location, or appear in the admin's family list.
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');
const DayNote = require('../models/DayNote');
const Rating = require('../models/Rating');
const PollenDay = require('../models/PollenDay');
const ReminderLog = require('../models/ReminderLog');
const DailyMessage = require('../models/DailyMessage');
const PushSubscription = require('../models/PushSubscription');
const { deleteUserSessions } = require('./sessions');
const D = require('./dates');

const DEMO_HOURS = 24;
const DEMO_MAX = () => Number(process.env.DEMO_MAX) || 200; // demo accounts alive at once
const DEMO_PLACE = { label: 'Sample city', lat: 0, lng: 0 }; // "0.00,0.00": no real user lives there

// Repeatable "random" per day, so every demo shows the same believable history.
function noise(date, salt) {
  const h = crypto.createHash('sha256').update(`${salt}:${date}`).digest();
  return h[0] / 255;
}

// Sample pollen: a seasonal wave plus day-to-day noise, 0–5. Shared by all demo accounts.
function samplePollen(date) {
  const doy = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${date.slice(0, 4)}-01-01T00:00:00Z`)) / 86400000);
  const season = (Math.sin(((doy - 60) / 365) * 2 * Math.PI) + 1) / 2; // peaks in spring
  const v = Math.round(Math.min(5, Math.max(0, 1 + season * 2.5 + (noise(date, 'pollen') - 0.5) * 3)));
  const tree = v;
  const grass = Math.max(0, v - 1 - Math.round(noise(date, 'grass')));
  const weed = Math.max(0, v - 2 + Math.round(noise(date, 'weed')));
  const overall = Math.max(tree, grass, weed);
  const top = [['Tree', tree], ['Grass', grass], ['Weed', weed]].filter(([, x]) => x === overall).map(([n]) => n).join(' + ');
  return { tree, grass, weed, overall, top: overall ? top : '' };
}

async function ensureSamplePollen(today) {
  const place = `${DEMO_PLACE.lat.toFixed(2)},${DEMO_PLACE.lng.toFixed(2)}`;
  const from = D.addDays(today, -100);
  const to = D.addDays(today, 4);
  const have = new Set((await PollenDay.find({ place, date: { $gte: from, $lte: to } }, { date: 1 }).lean()).map((r) => r.date));
  const missing = [];
  for (let d = from; d <= to; d = D.addDays(d, 1)) if (!have.has(d)) missing.push({ place, date: d, ...samplePollen(d), fetchedOn: today });
  if (!missing.length) return; // usually: only the first demo of the day writes anything
  try {
    await PollenDay.insertMany(missing, { ordered: false });
  } catch (err) {
    if (err.code !== 11000) throw err; // two demos started at once: the other one inserted them
  }
}

async function createDemo({ timezone = 'America/Chicago' } = {}) {
  if ((await User.countDocuments({ demo: true })) >= DEMO_MAX()) return null;
  const id = crypto.randomBytes(6).toString('hex');
  const user = await User.create({
    email: `demo-${id}@demo.invalid`,
    name: 'Demo',
    // Nobody knows this password: a demo account can only be entered through "Try the demo".
    passwordHash: await User.hashPassword(crypto.randomBytes(24).toString('hex')),
    timezone,
    role: 'member',
    demo: true,
    demoExpiresAt: new Date(Date.now() + DEMO_HOURS * 3600 * 1000),
    weeklySummary: false,
    pollen: DEMO_PLACE,
  });
  await seedDemo(user);
  return user;
}

async function seedDemo(user) {
  const today = D.localToday(user.timezone);
  const day = (n) => D.addDays(today, n);
  const uid = user._id;
  await ensureSamplePollen(today);

  // 1. A medication with everything on: supply, goal, rating, pollen, milestones, a past trip.
  const drops = await Habit.create({
    userId: uid, name: 'Allergy drops', kind: 'medication', icon: 'drop', startDate: day(-95),
    description: '3 drops under the tongue, hold for 2 minutes.',
    supply: { enabled: true, unit: 'doses', perCheckin: 1, size: 90, base: 7, baseAt: new Date(), baseDate: today, warnDays: 7, reorderUrl: '' },
    goal: { enabled: true, label: '3-year course', unit: 'days', perCheckin: 1, target: 1095, from: day(-95) },
    rating: { enabled: true },
    showPollen: true,
    timer: { mode: 'countdown', seconds: 120 },
    milestones: { enabled: true, seen: [7] }, // the 30-day badge celebrates on first look
    pauses: [{ from: day(-30), to: day(-27), reason: 'travel' }],
  });
  const missed = new Set([day(-70), day(-52)]);
  const checkins = [];
  const ratings = [];
  for (let i = -95; i <= -1; i++) {
    const d = day(i);
    const paused = d >= day(-30) && d <= day(-27);
    if (!paused && !missed.has(d)) checkins.push({ userId: uid, habitId: drops._id, date: d, source: 'import' });
    if (i >= -45) {
      // Symptoms follow pollen, a bit worse on missed days, plus noise.
      const p = samplePollen(d).overall;
      const s = Math.round(1 + p * 0.6 + (missed.has(d) ? 1 : 0) + (noise(d, 'mood') - 0.5) * 1.4);
      ratings.push({ userId: uid, habitId: drops._id, date: d, score: Math.min(5, Math.max(1, s)) });
    }
  }

  // 2. A Mon/Wed/Fri habit with a couple of misses and a bonus Saturday.
  const gym = await Habit.create({
    userId: uid, name: 'Gym', kind: 'habit', icon: 'dumbbell', startDate: day(-60),
    schedule: { every: false, days: [1, 3, 5] }, milestones: { enabled: true, seen: [] },
    timer: { mode: 'stopwatch', seconds: 30 },
    goal: { enabled: true, label: 'Fall training', by: 'minutes', unit: 'minutes', perCheckin: 1, target: 1500, from: day(-60) },
  });
  for (let i = -60; i <= -1; i++) {
    const d = day(i);
    const w = D.dow(d);
    const scheduled = [1, 3, 5].includes(w);
    if ((scheduled && noise(d, 'gym') > 0.15) || (w === 6 && noise(d, 'sat') > 0.8)) {
      checkins.push({ userId: uid, habitId: gym._id, date: d, source: 'import', duration: 1500 + Math.round(noise(d, 'mins') * 2400) });
    }
  }

  // 3. A reading habit with a page goal and a "5 is a good day" rating.
  const read = await Habit.create({
    userId: uid, name: 'Read', kind: 'habit', icon: 'book', startDate: day(-20),
    goal: { enabled: true, label: 'Book club pick', unit: 'pages', perCheckin: 20, target: 480, from: day(-20) },
    rating: { enabled: true, question: 'How was reading today?', lowIsGood: false },
    milestones: { enabled: true, seen: [] },
  });
  for (let i = -20; i <= -1; i++) {
    const d = day(i);
    if (noise(d, 'read') > 0.2) {
      checkins.push({ userId: uid, habitId: read._id, date: d, source: 'import' });
      ratings.push({ userId: uid, habitId: read._id, date: d, score: 3 + Math.round(noise(d, 'enjoy') * 2) });
    }
  }

  await Checkin.insertMany(checkins);
  await Rating.insertMany(ratings);
  await DayNote.insertMany([
    { userId: uid, habitId: drops._id, date: day(-29), text: 'Traveling. Left the drops at home, so this trip is paused.' },
    { userId: uid, habitId: drops._id, date: day(-52), text: 'Forgot. Busy day, symptoms worse by evening.' },
    { userId: uid, habitId: drops._id, date: day(-3), text: 'Best week in a while.' },
    { userId: uid, habitId: gym._id, date: day(-2), text: 'Leg day.' },
  ].filter((n) => n.date >= day(-95)));
}

// Removes expired demo accounts and everything they own. Safe to run any time.
async function cleanupDemos(now = new Date()) {
  const expired = await User.find({ demo: true, demoExpiresAt: { $lt: now } }, { _id: 1 }).lean();
  for (const { _id } of expired) {
    const habitIds = (await Habit.find({ userId: _id }, { _id: 1 }).lean()).map((h) => h._id);
    await Promise.all([
      Checkin.deleteMany({ userId: _id }),
      DayNote.deleteMany({ userId: _id }),
      Rating.deleteMany({ userId: _id }),
      ReminderLog.deleteMany({ habitId: { $in: habitIds } }),
      DailyMessage.deleteMany({ userId: _id }),
      PushSubscription.deleteMany({ userId: _id }),
      Habit.deleteMany({ userId: _id }),
      deleteUserSessions(_id),
    ]);
    await User.deleteOne({ _id, demo: true });
  }
  return expired.length;
}

function startDemoCleanup() {
  const run = () => cleanupDemos().catch((err) => console.error('Demo cleanup failed:', err.message));
  run();
  setInterval(run, 30 * 60 * 1000).unref();
}

module.exports = { createDemo, seedDemo, cleanupDemos, startDemoCleanup, samplePollen, DEMO_HOURS, DEMO_PLACE };
