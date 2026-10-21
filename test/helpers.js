// Starts a throwaway database + the real server.js, and gives tests a cookie-keeping client.
// Nothing here touches Atlas or your .env database: MONGODB_URI is overridden for the child process.
const { spawn } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');

async function startDatabase(name) {
  // TEST_MONGODB_URI lets CI or a local mongod be used instead of the in-memory server.
  if (process.env.TEST_MONGODB_URI) {
    return { uri: `${process.env.TEST_MONGODB_URI.replace(/\/$/, '')}/${name}`, stop: async () => {} };
  }
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const server = await MongoMemoryServer.create();
  return { uri: server.getUri(name), stop: () => server.stop() };
}

async function startApp({ name, port, seed, env = {} }) {
  const db = await startDatabase(name);
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  const seeded = seed ? await seed() : {};
  await mongoose.disconnect();

  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      MONGODB_URI: db.uri,
      APP_ORIGIN: base,
      SESSION_SECRET: 'test-secret-'.repeat(4),
      API_NINJAS_KEY: '',      // never spend real API quota in tests: fallback quotes are used
      VAPID_PUBLIC_KEY: '',    // push off
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: '',
      POLLEN_API_KEY: '',      // pollen off unless a test turns it on (against a local stub)
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  // Wait for /health
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server.js exited early:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    base,
    uri: db.uri,
    seeded,
    logs: () => stderr,
    async stop() {
      child.kill();
      await db.stop();
    },
  };
}

// A browser-like client: keeps its cookie and sends a same-site Origin header.
// form: an object, or [[key, value], …] for repeated keys like checkboxes.
function client(base) {
  let cookie = '';
  return async (urlPath, { method = 'GET', form, origin = base } = {}) => {
    const res = await fetch(base + urlPath, {
      method,
      redirect: 'manual',
      headers: {
        cookie,
        origin,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  };
}

// Runs fn with a direct database connection (for setup and assertions).
async function withDb(uri, fn) {
  await mongoose.connect(uri);
  try {
    return await fn();
  } finally {
    await mongoose.disconnect();
  }
}

function localToday(tz = 'America/Chicago') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

module.exports = { startApp, startDatabase, client, withDb, localToday, ROOT };
