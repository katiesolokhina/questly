// Pollen: Google Pollen API (daily index) + Open-Meteo geocoding (place name → coordinates).
//
// Cost safety, in layers:
//   1. One fetch per place per day: each fetch stores today + 4 forecast days, and today's row
//      remembers when it was refreshed, so page views read the database, not Google.
//   2. A failed fetch isn't retried for 30 minutes.
//   3. A hard daily cap (POLLEN_DAILY_CAP, default 100) claimed atomically in the database
//      before every call, so even a loop can't run past it.
const ApiUsage = require('../models/ApiUsage');
const PollenDay = require('../models/PollenDay');

const POLLEN_BASE = () => process.env.POLLEN_API_BASE || 'https://pollen.googleapis.com';
const GEO_BASE = () => process.env.GEOCODE_API_BASE || 'https://geocoding-api.open-meteo.com';
const DAILY_CAP = () => Number(process.env.POLLEN_DAILY_CAP) || 100;
const RETRY_MS = 30 * 60 * 1000;

const LEVELS = ['None', 'Very low', 'Low', 'Moderate', 'High', 'Very high'];
const TYPES = { TREE: 'Tree', GRASS: 'Grass', WEED: 'Weed' };

const configured = () => Boolean(process.env.POLLEN_API_KEY);
const round = (n) => Math.round(n * 100) / 100;
const placeOf = (loc) => `${round(loc.lat).toFixed(2)},${round(loc.lng).toFixed(2)}`;
const pad = (n) => String(n).padStart(2, '0');

const lastFailure = new Map(); // place → time of last failed fetch (per process)

async function claimCall() {
  const day = new Date().toISOString().slice(0, 10);
  const doc = await ApiUsage.findOneAndUpdate(
    { api: 'pollen', date: day },
    { $inc: { count: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return doc.count <= DAILY_CAP();
}

// Google's response → rows for PollenDay.
function parseForecast(data) {
  const rows = [];
  for (const d of data.dailyInfo || []) {
    const date = `${d.date.year}-${pad(d.date.month)}-${pad(d.date.day)}`;
    const values = { tree: null, grass: null, weed: null };
    for (const t of d.pollenTypeInfo || []) {
      const key = String(t.code || '').toLowerCase();
      if (!(key in values)) continue;
      if (t.indexInfo && Number.isFinite(t.indexInfo.value)) values[key] = t.indexInfo.value;
      else if (t.inSeason === false) values[key] = 0; // out of season = none
    }
    const known = Object.entries(values).filter(([, v]) => v !== null);
    const max = known.length ? Math.max(...known.map(([, v]) => v)) : null;
    const top = max ? known.filter(([, v]) => v === max).map(([k]) => TYPES[k.toUpperCase()]).join(' + ') : '';
    rows.push({ date, ...values, overall: max, top });
  }
  return rows;
}

// Makes sure today's pollen for this location is in the database. Never throws.
async function ensureToday(loc, today) {
  if (!configured() || !loc || loc.lat == null) return false;
  const place = placeOf(loc);
  try {
    if (await PollenDay.exists({ place, date: today, fetchedOn: today })) return true;
    const failedAt = lastFailure.get(place);
    if (failedAt && Date.now() - failedAt < RETRY_MS) return false;
    if (!(await claimCall())) {
      console.warn('Pollen: daily request cap reached, skipping fetch');
      return false;
    }
    const url = `${POLLEN_BASE()}/v1/forecast:lookup?key=${encodeURIComponent(process.env.POLLEN_API_KEY)}`
      + `&location.latitude=${round(loc.lat)}&location.longitude=${round(loc.lng)}&days=5&plantsDescription=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseForecast(await res.json());
    await Promise.all(rows.map((r) => PollenDay.updateOne(
      { place, date: r.date },
      { $set: { ...r, fetchedOn: today } },
      { upsert: true }
    )));
    lastFailure.delete(place);
    return true;
  } catch (err) {
    lastFailure.set(place, Date.now());
    console.warn(`Pollen fetch failed for ${place}: ${err.message}`); // never logs the key
    return false;
  }
}

// Map date → { overall, top, tree, grass, weed } for a location and date range.
async function pollenDays(loc, from, to) {
  if (!loc || loc.lat == null) return new Map();
  const rows = await PollenDay.find({ place: placeOf(loc), date: { $gte: from, $lte: to } }).lean();
  return new Map(rows.map((r) => [r.date, r]));
}

function describe(row) {
  if (!row || row.overall == null) return null;
  return {
    value: row.overall,
    level: LEVELS[row.overall],
    top: row.overall > 0 ? row.top : '',
    types: [['Tree', row.tree], ['Grass', row.grass], ['Weed', row.weed]]
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([name, v]) => ({ name, value: v, level: LEVELS[v] })),
  };
}

// ---------- Geocoding (free, no key) ----------
const STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware',
  dc: 'district of columbia', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
  nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon',
  pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah',
  vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
};

// "Dallas, TX" / "Brooklyn, New York" / "75201" → { label, lat, lng } or null.
async function geocode(query) {
  const parts = String(query || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts[0].length < 2) return null;
  const hint = parts.slice(1).join(' ').toLowerCase().replace(/\./g, '');
  const state = STATES[hint] || hint;
  const url = `${GEO_BASE()}/v1/search?name=${encodeURIComponent(parts[0])}&count=10&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
  const results = (await res.json()).results || [];
  const match = results.find((r) => !hint
    || (r.admin1 || '').toLowerCase() === state
    || (r.country_code || '').toLowerCase() === hint
    || (r.country || '').toLowerCase() === hint) || null;
  if (!match) return null;
  return { label: [match.name, match.admin1 || match.country].filter(Boolean).join(', ').slice(0, 80), lat: round(match.latitude), lng: round(match.longitude) };
}

module.exports = { LEVELS, configured, placeOf, parseForecast, ensureToday, pollenDays, describe, geocode, round };
