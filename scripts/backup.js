// Nightly backup: every collection (except sessions) → one gzipped file, keeping the newest N.
//
//   node scripts/backup.js
//
// Env (optional): BACKUP_DIR (default: ./backups), BACKUP_KEEP (default: 14)
// Format: gzipped JSON lines. Line 1 is a header; each other line is { c: collection, d: document }
// in Extended JSON, so ObjectIds and Dates restore as their real types.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;
const SKIP = new Set(['sessions']); // short-lived logins: never worth restoring, and they're credentials
const DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !SKIP.has(n) && !n.startsWith('system.'))
    .sort();

  const counts = {};
  for (const n of names) counts[n] = await db.collection(n).countDocuments();

  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const file = path.join(DIR, `${db.databaseName}_${stamp}.jsonl.gz`);
  const tmp = `${file}.partial`;

  async function* lines() {
    yield JSON.stringify({ questlyBackup: 1, db: db.databaseName, createdAt: new Date().toISOString(), counts }) + '\n';
    for (const n of names) {
      for await (const doc of db.collection(n).find({})) {
        yield EJSON.stringify({ c: n, d: doc }, { relaxed: false }) + '\n';
      }
    }
  }

  // Write to .partial first, then rename: a crash mid-backup never leaves a broken file that looks complete.
  await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(tmp, { mode: 0o600 }));
  fs.renameSync(tmp, file);

  // Rotate: keep the newest KEEP backups of this database.
  const prefix = `${db.databaseName}_`;
  const old = fs.readdirSync(DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl.gz')).sort().reverse().slice(KEEP);
  for (const f of old) fs.unlinkSync(path.join(DIR, f));

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log(`${new Date().toISOString()} backup ok: ${path.basename(file)} (${total} docs, ${kb} KB)` +
    `${old.length ? `, removed ${old.length} old` : ''}`);
}

main()
  .catch((err) => { console.error(`${new Date().toISOString()} backup FAILED: ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
