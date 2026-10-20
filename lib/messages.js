// Quotes + advice from API Ninjas, cached per user per day.
// Every check-in that day gets a message no other check-in is showing:
// quote, advice, quote, advice… The API is only called when the day's cache runs out.
// If the API is down, over quota, or the key is missing, a built-in line is used instead,
// so a check-in never fails because of this.

const DailyMessage = require('../models/DailyMessage');
const Checkin = require('../models/Checkin');

const API_BASE = 'https://api.api-ninjas.com';
const QUOTE_CATEGORIES = ['inspirational', 'success', 'courage', 'happiness', 'wisdom'];
const MAX_LENGTH = 180; // keeps the quote panel to a few lines on a phone

const FALLBACK = {
  quote: [
    { text: 'Drop by drop is the water pot filled.', author: 'The Buddha' },
    { text: 'It does not matter how slowly you go as long as you do not stop.', author: 'Confucius' },
    { text: 'Success is the sum of small efforts, repeated day in and day out.', author: 'Robert Collier' },
    { text: 'A journey of a thousand miles begins with a single step.', author: 'Lao Tzu' },
    { text: 'Constant dripping hollows out a stone.', author: 'Lucretius' },
  ],
  advice: [
    { text: 'Tie a new habit to one you already do every day.' },
    { text: 'Set things out the night before so the first step is already done.' },
    { text: 'On hard days, do the smallest version. It still counts.' },
    { text: 'Missing once is an accident. Missing twice is the start of a new habit.' },
    { text: 'Notice how you feel after, not just before.' },
  ],
};

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Same fallback all day for a given date, different across days.
function fallbackFor(type, date) {
  const list = FALLBACK[type];
  const seed = [...date].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return { type, ...list[seed % list.length], source: 'fallback' };
}

async function apiGet(path, params = {}) {
  const key = process.env.API_NINJAS_KEY;
  if (!key) throw new Error('API_NINJAS_KEY is not set');
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'X-Api-Key': key },
    signal: AbortSignal.timeout(4000), // never let a slow API hold up a check-in
  });
  if (!res.ok) throw new Error(`API Ninjas ${path} responded ${res.status}`);
  return res.json();
}

// Collapse stray whitespace and add a missing space after , ; :
// (lookahead skips digits so "1,000" stays intact).
function tidy(s) {
  return s.trim().replace(/\s+/g, ' ').replace(/([,;:])(?=[^\s\d])/g, '$1 ');
}

async function fetchQuote() {
  // Two tries in case the first one is too long for the panel.
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await apiGet('/v2/randomquotes', {
      categories: pickRandom(QUOTE_CATEGORIES),
      exclude_categories: 'faith,death',
    });
    const q = Array.isArray(data) ? data[0] : null;
    const text = q && typeof q.quote === 'string' ? tidy(q.quote) : '';
    if (text && text.length <= MAX_LENGTH) {
      const author = typeof q.author === 'string' && q.author.trim() ? q.author.trim() : undefined;
      return { type: 'quote', text, author, source: 'api' };
    }
  }
  throw new Error('No quote short enough');
}

async function fetchAdvice() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await apiGet('/v1/advice');
    const text = data && typeof data.advice === 'string' ? tidy(data.advice) : '';
    if (text && text.length <= MAX_LENGTH) return { type: 'advice', text, source: 'api' };
  }
  throw new Error('No advice short enough');
}

// One new message of the given type, not repeating anything in `exclude`.
// API first (up to 3 tries to dodge a repeat), then the built-in list.
async function fetchFresh(type, date, exclude) {
  const fetcher = type === 'quote' ? fetchQuote : fetchAdvice;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const item = await fetcher();
      if (!exclude.has(item.text)) return item;
    } catch (err) {
      console.warn(`${type} fetch failed:`, err.message);
      break; // API is down or out of quota: don't keep hammering it
    }
  }
  const list = FALLBACK[type];
  const start = fallbackFor(type, date);
  const offset = list.findIndex((f) => f.text === start.text);
  for (let i = 0; i < list.length; i++) {
    const f = list[(offset + i) % list.length];
    if (!exclude.has(f.text)) return { type, ...f, source: 'fallback' };
  }
  return start; // every built-in line already used today: repeating is the only option
}

// Today's cached pool for this user, created on first use.
async function getPool(userId, date) {
  const existing = await DailyMessage.findOne({ userId, date }).lean();
  if (existing) return existing.items;
  const first = await fetchFresh('quote', date, new Set());
  try {
    await DailyMessage.create({ userId, date, items: [first] });
    return [first];
  } catch (err) {
    // Two check-ins at the same moment: the other request created the pool first.
    if (err.code === 11000) return (await DailyMessage.findOne({ userId, date }).lean()).items;
    throw err;
  }
}

// Picks a message no other check-in is showing today. Reuses cached ones first
// (so undo + re-check-in costs no API call) and only fetches when the pool runs out.
// Types alternate as the pool grows: quote, advice, quote, advice…
async function messageForCheckin(userId, date) {
  const pool = await getPool(userId, date);
  const shown = await Checkin.find({ userId, date, 'message.text': { $exists: true } }, { 'message.text': 1 }).lean();
  const inUse = new Set(shown.map((c) => c.message.text));

  let item = pool.find((p) => !inUse.has(p.text));
  if (!item) {
    const type = pool.length % 2 === 0 ? 'quote' : 'advice';
    item = await fetchFresh(type, date, new Set(pool.map((p) => p.text)));
    await DailyMessage.updateOne({ userId, date }, { $push: { items: item } });
  }
  return { type: item.type, text: item.text, author: item.author };
}

module.exports = { messageForCheckin };
