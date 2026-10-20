// Creates or updates a user, and optionally a habit with imported history.
//
// Usage:
//   node scripts/seed.js --email=you@example.com --name=Katie
//   node scripts/seed.js --email=you@example.com --habit="Morning walk" --start=2026-01-01
// Options:
//   --tz=America/Chicago     timezone (default America/Chicago)
//   --habit="Name"           habit to create/import into (optional)
//   --start=YYYY-MM-DD       first day to mark as done (required with --habit)
//   --until=YYYY-MM-DD       last day to mark as done (default: yesterday)
//   --medication             mark the habit as a medication (drop icon)
//   --reset-password         change the password of an existing user
// Safe to re-run: never duplicates users, habits, or check-ins.

require('dotenv').config({ quiet: true });
const readline = require('readline');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Habit = require('../models/Habit');
const Checkin = require('../models/Checkin');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);

function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function localToday(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Prompts without echoing the password (prints * instead).
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(rl.muted ? '*' : s);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    rl.muted = true;
  });
}

async function choosePassword() {
  const pw = await askHidden('New password (8+ chars): ');
  if (pw.length < 8) throw new Error('Password must be at least 8 characters.');
  const again = await askHidden('Confirm password: ');
  if (pw !== again) throw new Error('Passwords do not match.');
  return User.hashPassword(pw);
}

async function main() {
  const email = String(args.email || '').trim().toLowerCase();
  const name = typeof args.name === 'string' ? args.name : null;
  const tz = typeof args.tz === 'string' ? args.tz : 'America/Chicago';
  const habitName = typeof args.habit === 'string' ? args.habit.trim() : null;
  const start = typeof args.start === 'string' ? args.start : null;
  if (!email) throw new Error('Pass --email=you@example.com');
  if (habitName && !isDate(start)) throw new Error('--habit needs --start=YYYY-MM-DD');

  await connectDB(process.env.MONGODB_URI);

  // 1. User
  let user = await User.findOne({ email });
  if (!user) {
    if (!name) throw new Error('New user: pass --name=YourName');
    user = await User.create({ email, name, timezone: tz, passwordHash: await choosePassword() });
    console.log(`Created user ${email}`);
  } else {
    if (args['reset-password']) user.passwordHash = await choosePassword();
    if (name) user.name = name;
    user.timezone = tz;
    await user.save();
    console.log(`Updated user ${email}`);
  }

  if (!habitName) return;

  // 2. Habit
  let habit = await Habit.findOne({ userId: user._id, name: habitName });
  if (!habit) {
    const med = Boolean(args.medication);
    habit = await Habit.create({
      userId: user._id,
      name: habitName,
      kind: med ? 'medication' : 'habit',
      icon: med ? 'drop' : 'leaf',
      schedule: { every: true, days: [0, 1, 2, 3, 4, 5, 6] },
      startDate: start,
    });
    console.log(`Created habit: ${habitName}`);
  }

  // 3. Import history as done, start → until
  const until = isDate(args.until) ? args.until : addDays(localToday(tz), -1);
  const ops = [];
  for (let d = start; d <= until; d = addDays(d, 1)) {
    ops.push({
      updateOne: {
        filter: { habitId: habit._id, date: d },
        update: { $setOnInsert: { userId: user._id, habitId: habit._id, date: d, source: 'import', checkedInAt: new Date(`${d}T12:00:00Z`) } },
        upsert: true,
      },
    });
  }
  const result = ops.length ? await Checkin.bulkWrite(ops) : { upsertedCount: 0 };
  const total = await Checkin.countDocuments({ habitId: habit._id });
  console.log(`Imported ${start} → ${until}: ${result.upsertedCount} new, ${total} total check-ins`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());