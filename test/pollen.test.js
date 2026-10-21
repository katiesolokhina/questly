// Pollen: parsing, the settings flow, the dashboard card, and every cost guard.
// Google and Open-Meteo are replaced by a local stub server; no real API is ever called.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp, client, withDb, localToday } = require('./helpers');
const P = require('../lib/pollen');
const User = require('../models/User');
const Habit = require('../models/Habit');
const PollenDay = require('../models/PollenDay');
const ApiUsage = require('../models/ApiUsage');

const KEY = 'test-pollen-key-123456';
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dateObj = (s) => { const [year, month, day] = s.split('-').map(Number); return { year, month, day }; };

function forecast(today) {
  return {
    regionCode: 'us',
    dailyInfo: [0, 1, 2, 3, 4].map((i) => ({
      date: dateObj(addDays(today, i)),
      pollenTypeInfo: [
        { code: 'TREE', displayName: 'Tree', inSeason: true, indexInfo: { code: 'UPI', value: 4, category: 'High' } },
        { code: 'GRASS', displayName: 'Grass', inSeason: true, indexInfo: { code: 'UPI', value: 2, category: 'Low' } },
        { code: 'WEED', displayName: 'Weed', inSeason: false },
      ],
    })),
  };
}

test('parseForecast: dates, out-of-season = 0, overall = the highest type', () => {
  const rows = P.parseForecast(forecast('2026-10-21'));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { date: '2026-10-21', tree: 4, grass: 2, weed: 0, overall: 4, top: 'Tree' });
  assert.equal(P.describe(rows[0]).level, 'High');
  assert.equal(P.describe({ overall: null }), null);
});

test('pollen flow', async (t) => {
  const today = localToday();
  const hits = { pollen: 0, geo: 0 };
  let fail = false;
  const stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/v1/forecast:lookup') {
      hits.pollen++;
      assert.equal(url.searchParams.get('key'), KEY);
      if (fail) { res.statusCode = 500; return res.end('{}'); }
      return res.end(JSON.stringify(forecast(today)));
    }
    if (url.pathname === '/v1/search') {
      hits.geo++;
      const name = url.searchParams.get('name');
      if (name === 'Dallas') {
        return res.end(JSON.stringify({ results: [
          { name: 'Dallas', admin1: 'Texas', country: 'United States', country_code: 'US', latitude: 32.78306, longitude: -96.80667 },
          { name: 'Dallas', admin1: 'Georgia', country: 'United States', country_code: 'US', latitude: 33.92371, longitude: -84.84077 },
        ] }));
      }
      return res.end('{}');
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  const app = await startApp({
    name: 'questly_test_pollen',
    port: 3993,
    env: { POLLEN_API_KEY: KEY, POLLEN_API_BASE: stubBase, GEOCODE_API_BASE: stubBase },
    async seed() {
      const user = await User.create({ email: 'p@test.dev', name: 'P', role: 'admin', passwordHash: await User.hashPassword('pollen pass 1') });
      const med = await Habit.create({ userId: user._id, name: 'Drops', kind: 'medication', icon: 'drop', startDate: addDays(today, -10), rating: { enabled: true } });
      const walk = await Habit.create({ userId: user._id, name: 'Walk', kind: 'habit', icon: 'leaf', startDate: addDays(today, -10) });
      return { med: med.id, walk: walk.id };
    },
  });
  t.after(async () => { await app.stop(); stub.close(); });
  const c = client(app.base);
  const { med, walk } = app.seeded;
  await c('/login', { method: 'POST', form: { email: 'p@test.dev', password: 'pollen pass 1' } });

  await t.test('no location yet: no card, no API calls', async () => {
    const dash = (await c(`/?h=${med}`)).text;
    assert.doesNotMatch(dash, /pollen-card/);
    assert.equal(hits.pollen, 0);
    assert.match((await c('/settings')).text, /City or ZIP code/);
  });

  await t.test('settings: "City, State" picks the right state; unknown places and blanks are refused', async () => {
    let r = await c('/settings/pollen', { method: 'POST', form: { place: 'Nowhere, TX' } });
    assert.equal(r.status, 422);
    assert.match(r.text, /Couldn’t find that place/);
    r = await c('/settings/pollen', { method: 'POST', form: { place: '' } });
    assert.equal(r.status, 422);
    r = await c('/settings/pollen', { method: 'POST', form: { place: 'Dallas, GA' } });
    assert.match(r.location, /saved=pollenOn/);
    assert.match((await c('/settings')).text, /Dallas, Georgia/);
    await c('/settings/pollen', { method: 'POST', form: { place: 'Dallas, TX' } });
    const u = await withDb(app.uri, () => User.findOne({ email: 'p@test.dev' }).lean());
    assert.deepEqual({ ...u.pollen }, { label: 'Dallas, Texas', lat: 32.78, lng: -96.81 }); // rounded, ~1 km
  });

  await t.test('dashboard: medication shows today, fetched once; reloads read the database', async () => {
    const dash = (await c(`/?h=${med}`)).text;
    assert.match(dash, /Pollen today · Dallas, Texas/);
    assert.match(dash, /pollen-level">High <span class="muted">· Tree/);
    assert.equal(hits.pollen, 1);
    await c(`/?h=${med}`);
    await c(`/?h=${med}`);
    assert.equal(hits.pollen, 1, 'one call per place per day');
    assert.equal(await withDb(app.uri, () => PollenDay.countDocuments({})), 5, 'today + 4 forecast days stored');
  });

  await t.test('habits are off by default and can opt in; the rating chart gets a pollen line', async () => {
    assert.doesNotMatch((await c(`/?h=${walk}`)).text, /pollen-card/);
    await c(`/habits/${walk}`, { method: 'POST', form: { name: 'Walk', kind: 'habit', icon: 'leaf', schedule: 'every', startDate: addDays(today, -10), showPollen: 'on', ratingOn: 'on' } });
    await c(`/habits/${walk}/day/${today}/rating`, { method: 'POST', form: { score: '3', back: 'home' } });
    const dash = (await c(`/?h=${walk}`)).text;
    assert.match(dash, /pollen-card/);
    assert.match(dash, /class="trend-pollen"/);
    assert.match(dash, /Pollen<\/li>/);
    assert.equal(hits.pollen, 1);
  });

  await t.test('cost guards: daily cap, retry back-off after a failure, key never logged', async () => {
    // Cap: pretend 100 calls were already made today, wipe stored data → no new call.
    await withDb(app.uri, async () => {
      await PollenDay.deleteMany({});
      await ApiUsage.updateOne({ api: 'pollen', date: new Date().toISOString().slice(0, 10) }, { $set: { count: 100 } }, { upsert: true });
    });
    let r = await c(`/?h=${med}`);
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /pollen-card/);
    assert.equal(hits.pollen, 1, 'cap reached: Google is not called');

    // Failure: under the cap again, Google errors → page still works, and no retry for 30 minutes.
    await withDb(app.uri, () => ApiUsage.deleteMany({}));
    fail = true;
    r = await c(`/?h=${med}`);
    assert.equal(r.status, 200);
    assert.equal(hits.pollen, 2);
    await c(`/?h=${med}`);
    assert.equal(hits.pollen, 2, 'backs off after a failure');
    assert.doesNotMatch(app.logs(), new RegExp(KEY), 'the API key never appears in logs');
  });

  await t.test('"Use my location" and turning it off', async () => {
    let r = await c('/settings/pollen', { method: 'POST', form: { place: '', lat: '40.71', lng: '-74.01' } });
    assert.match(r.location, /saved=pollenOn/);
    assert.match((await c('/settings')).text, /Your location/);
    r = await c('/settings/pollen', { method: 'POST', form: { place: '', lat: '999', lng: '0' } });
    assert.equal(r.status, 422);
    await c('/settings/pollen/off', { method: 'POST', form: {} });
    assert.doesNotMatch((await c(`/?h=${med}`)).text, /pollen-card/);
    assert.match((await c('/settings')).text, /City or ZIP code/);
  });
});
