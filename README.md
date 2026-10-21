# Questly

**Your daily quests.** Questly is a small, fast web app for daily check-ins: medications, habits, anything you want to do on a schedule. It's built as an installable PWA with push reminders and family accounts, and it runs in production on my own server.

Live at [questly.trisolocreations.com](https://questly.trisolocreations.com) (invite-only).

Built by [Katie Solokhina](https://katie.trisolocreations.com).

---

## What it does

**Core**
- **One-tap check-in** for each habit, with a quote or piece of advice after each check-in. The quotes come from [API Ninjas](https://api-ninjas.com) and are never repeated within the same day.
- **Every day or specific weekdays.** Unscheduled days are *off days*: they're never missed, and checking in on one adds a bonus day to your streak.
- **Month calendar** showing done, missed, off and paused days, plus streak, total, and percent on schedule for the month.
- **Day pages** where you can fix a past day ("took it, forgot to log"). Each day also takes a private note.
- **Push reminders** at a time you choose, only if you haven't checked in yet. Medications get one follow-up nudge two hours later.

**Optional add-ons, per habit**
- **Pause / travel mode:** plan a break or add one after the fact. Paused days don't break your streak, don't count toward your adherence, and don't trigger reminders.
- **Supply countdown:** for example, "6 doses left · runs out around Mon, Oct 26". It shows a running-low badge, sends one push per refill, and has a reorder link.
- **Goal:** a count-up target, such as "87 of 1,095 days" or "60 of 100 pages", with a projected finish date.
- **Daily rating:** a 1–5 question with your own wording and labels, and a monthly trend chart. It also tells you things like "Done days averaged 1.8, missed days 3.2."
- **Milestones:** badges at 7, 30, 60, 100, 180 and 365 days and beyond, each with a celebration that shows exactly once.
- **Pollen:** today's tree, grass and weed levels for your city, and a pollen line on the rating chart. It answers "is it the medication or the season?" with findings like "Higher-pollen days averaged 3.2, low-pollen days 1.9." It's on by default for medications.

**Around the app**
- **Weekly summary:** a page showing each habit Mon–Sun, plus a push every Sunday at 7 PM.
- **Home-screen shortcuts:** Check in, Note, and Week, on Android and desktop.
- **Family accounts:** the admin invites members with one-time links. The admin can reset access, turn accounts off, or delete them, but never sees anyone's data.
- **Settings:** password change (signs out your other devices), light, dark or system theme, archived habits, and CSV export.

## Stack

| Layer | Choice |
|---|---|
| Server | Node.js, Express 5 |
| Views | EJS, server-rendered; JavaScript only where it adds something (push setup, sharing) |
| Data | MongoDB (Atlas) with Mongoose 9 |
| Sessions | express-session + connect-mongo |
| Security | helmet (CSP, no inline scripts), express-rate-limit, bcrypt |
| Push | Web Push (VAPID) via `web-push` |
| External data | [Google Pollen API](https://developers.google.com/maps/documentation/pollen), [Open-Meteo geocoding](https://open-meteo.com) (free, no key), [API Ninjas](https://api-ninjas.com) |
| PWA | Web app manifest, service worker, offline page |
| Hosting | Ubuntu VPS, Nginx reverse proxy, PM2, Let's Encrypt |
| Tests | Node's built-in test runner, against the real server and a throwaway database |

There's no frontend framework and no build step: pages work without JavaScript, and they load quickly on a phone.

## Design decisions worth knowing

- **Dates are local calendar strings** (`YYYY-MM-DD`), computed in each user's time zone. Date arithmetic runs on UTC midnights, so daylight-saving changes can never skip or repeat a day. "Today" is never the server's today.
- **Counters are derived, never decremented.** Supply left = amount at the last refill minus the check-ins since then. That's why undo, backfill and past-day fixes always give the right number, and it can't drift.
- **Exactly-once side effects come from atomic database claims, not timers.** Reminders, low-supply alerts, the weekly push and milestone celebrations each claim their slot with a conditional update or a unique index *before* acting. A restart, two overlapping ticks or a page reload can never send or show anything twice.
- **Paid APIs can't run up a bill.** Pollen is fetched once per place per day (today + a 4-day forecast, saved), pre-fetched at 6 AM so pages never wait, and backs off for 30 minutes after a failure. A hard daily cap is claimed atomically in the database before every call, and the key is restricted to one API and the server's IP. Tests run against a local stub, so the real API is never called.
- **Location stays coarse.** Pollen needs only a city, so coordinates are rounded to about 1 km and no street address is ever stored.
- **CSRF protection** combines SameSite=Lax cookies with an `Origin` check on every state-changing request. Links (including home-screen shortcuts) only ever navigate; changing data always takes a POST.
- **Invite and reset links** are random tokens stored only as SHA-256 hashes. They're single-use (claimed atomically) and expire.
- **Privacy between family members:** an admin manages *accounts*, not data. No route lets one user read another user's habits.
- **User content is always escaped**, and CSV exports neutralize spreadsheet formulas (a habit named `=HYPERLINK(…)` stays text).

## Project structure

```
server.js            App setup, security middleware, routes, reminder loop
config/db.js         Mongo connection
middleware/          Auth (requireAuth) and same-origin checks
models/              User, Habit, Checkin, DayNote, Rating, PollenDay, ApiUsage, ReminderLog, PushSubscription, AccessToken, DailyMessage
lib/
  dates.js           Calendar math, month grid, streak + adherence
  habits.js          Builds everything the dashboard shows
  counter.js         Supply countdown + goal math
  ratings.js         Rating settings + monthly trend
  milestones.js      Best streak + badges
  weekly.js          Weekly summary + push wording
  pollen.js          Pollen fetch + cache + cost guards, place-name geocoding
  reminders.js       The once-a-minute tick: reminders, supply alerts, weekly push, pollen pre-fetch
  push.js, messages.js, export.js, sessions.js, icons.js
routes/              One file per area (auth, checkins, habits, settings, family, week, go…)
views/               EJS pages + partials
public/              CSS, small JS files, icons, manifest, service worker
scripts/             backup, restore, make-admin, seed
test/                Unit tests (date, counter, rating, milestone, weekly math) + end-to-end flows
```

## Running it locally

Requirements: Node 18+ and a MongoDB database (a free Atlas cluster works).

```bash
git clone https://github.com/katiesolokhina/questly.git
cd questly
npm install
cp .env.example .env      # then fill it in (see below)
npm run dev               # http://localhost:3001
```

Create your first account with the seed script (its options are described at the top of `scripts/seed.js`), then make it the admin:

```bash
node scripts/make-admin.js --email=you@example.com
```

### Environment variables

| Name | Required | What it's for |
|---|---|---|
| `MONGODB_URI` | yes | Mongo connection string, including the database name |
| `SESSION_SECRET` | yes | Long random string for signing session cookies |
| `APP_ORIGIN` | yes | Public origin, e.g. `http://localhost:3001`; requests from any other origin are rejected |
| `PORT` | no | Default 3001 |
| `NODE_ENV` | no | `production` turns on secure cookies |
| `API_NINJAS_KEY` | no | Quotes and advice; without it, built-in fallbacks are used |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | no | Push notifications; without them, push is simply off |
| `POLLEN_API_KEY` | no | Google Pollen API key; without it, the pollen feature is hidden |
| `POLLEN_DAILY_CAP` | no | Maximum Pollen API calls per day (default 100) |
| `BACKUP_DIR`, `BACKUP_KEEP` | no | Where backups go (default `./backups`) and how many to keep (default 14) |

Generate the secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET
npx web-push generate-vapid-keys                                           # VAPID keys
```

## Tests

```bash
npm test
```

The suite has over 100 tests:
- **Unit tests** for the date, streak, pause, counter, rating, milestone and weekly rules, and for pollen parsing. These run in milliseconds.
- **End-to-end tests** that start the real `server.js` against an in-memory MongoDB and drive it like a browser. They cover sign-in, check-in and undo, past-day fixes, notes, pauses, counters, ratings, milestones, the week page, shortcuts, settings, family invites and resets, CSRF rejection, and escaping.
- **Tests for the reminder loop,** run in-process at fixed times. These include a Sunday when the clocks fall back.
- **Pollen tests** against a local stub of Google and Open-Meteo. They cover one call per day, the daily cap, back-off after a failure, and that the key never appears in logs.

Tests never touch your real database. Set `TEST_MONGODB_URI` to use a local `mongod` instead of the in-memory server.

## Deployment

It runs behind Nginx on a small VPS, kept alive by PM2:

```bash
git pull && npm ci --omit=dev && pm2 restart questly
```

- **TLS:** Let's Encrypt via certbot, renewed automatically.
- **Backups:** a nightly cron runs `node scripts/backup.js`. It writes every collection except sessions to one gzipped JSON-lines file, keeps the newest 14, and writes atomically.
- **Restoring:** `node scripts/restore.js <file>` restores into a separate `<db>-restore` database by default, so you can check it first. Overwriting the live database takes `--target=<db> --force`.

## Security notes

- `.env` and `backups/` are git-ignored. Never commit them.
- Login and password-change attempts are rate limited.
- Changing your password signs out every other session.
- A disabled account is signed out everywhere immediately. It's told it's disabled only after a correct password, so the message doesn't reveal which accounts exist.
