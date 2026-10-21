// Restores a backup made by scripts/backup.js.
//
//   node scripts/restore.js backups/questly_2026-10-21_08-30-00.jsonl.gz
//       → restores into a NEW database "<name>-restore", leaving the live one untouched,
//         so you can inspect it (point a local .env at it) before deciding anything.
//
//   node scripts/restore.js <file> --target=questly --force
//       → overwrites the target database's backed-up collections. Only for real disasters.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const zlib = require('node:zlib');
const readline = require('node:readline');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.find((a) => a.startsWith(`--${name}`));
const BATCH = 500;

async function main() {
  if (!file || !fs.existsSync(file)) throw new Error('Pass the path to a .jsonl.gz backup file');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const it = rl[Symbol.asyncIterator]();
  const first = await it.next();
  let header = null;
  try { header = first.done ? null : JSON.parse(first.value); } catch { /* not JSON: handled below */ }
  if (!header || header.questlyBackup !== 1) throw new Error('Not a Questly backup file');

  const targetFlag = flag('target');
  const target = targetFlag ? targetFlag.split('=')[1] : `${header.db}-restore`;
  const force = Boolean(flag('force'));

  await mongoose.connect(process.env.MONGODB_URI, { dbName: target });
  const db = mongoose.connection.db;

  // Refuse to mix a restore into existing data unless explicitly told to replace it.
  for (const name of Object.keys(header.counts)) {
    const existing = await db.collection(name).countDocuments();
    if (existing && !force) {
      throw new Error(`Database "${target}" already has data in "${name}". Use a different --target, or add --force to replace it.`);
    }
    if (existing && force) await db.collection(name).deleteMany({});
  }

  const buffers = {};
  const restored = {};
  const flush = async (name) => {
    if (!buffers[name] || !buffers[name].length) return;
    await db.collection(name).insertMany(buffers[name], { ordered: false });
    restored[name] = (restored[name] || 0) + buffers[name].length;
    buffers[name] = [];
  };

  for (let line = await it.next(); !line.done; line = await it.next()) {
    if (!line.value) continue;
    const { c, d } = EJSON.parse(line.value, { relaxed: false });
    (buffers[c] ||= []).push(d);
    if (buffers[c].length >= BATCH) await flush(c);
  }
  for (const name of Object.keys(buffers)) await flush(name);

  console.log(`Restored backup from ${header.createdAt} into database "${target}":`);
  for (const [name, expected] of Object.entries(header.counts)) {
    const got = restored[name] || 0;
    console.log(`  ${got === expected ? 'ok ' : 'MISMATCH'} ${name}: ${got}/${expected}`);
    if (got !== expected) process.exitCode = 1;
  }
  console.log('Indexes are rebuilt automatically the first time the app connects to this database.');
}

main()
  .catch((err) => { console.error(`Restore failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
