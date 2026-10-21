// Grants the admin role to an existing account (run once per database).
// Usage: node scripts/make-admin.js --email=you@example.com
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');

const arg = process.argv.find((a) => a.startsWith('--email='));
const email = arg ? arg.slice(8).trim().toLowerCase() : '';

(async () => {
  if (!email) throw new Error('Pass --email=you@example.com');
  await connectDB(process.env.MONGODB_URI);
  const res = await User.updateOne({ email }, { $set: { role: 'admin', disabled: false } });
  if (!res.matchedCount) throw new Error(`No account with email ${email}`);
  console.log(`${email} is now an admin.`);
})()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
