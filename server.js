require('dotenv').config({ quiet: true });
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const path = require('path');
const { connectDB } = require('./config/db');
const { sameOrigin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const checkinRoutes = require('./routes/checkins');
const habitRoutes = require('./routes/habits');
const pushRoutes = require('./routes/push');
const { configurePush } = require('./lib/push');
const { startReminders } = require('./lib/reminders');
const settingsRoutes = require('./routes/settings');

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({ referrerPolicy: { policy: 'same-origin' } }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    name: 'questly.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // every visit pushes expiry out another 30 days
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, ttl: 60 * 60 * 24 * 30 }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd, // HTTPS-only cookie in production
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

app.use((req, res, next) => { res.locals.theme = ''; next(); });
app.use(sameOrigin);

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(authRoutes);

app.use(dashboardRoutes);
app.use(checkinRoutes);
app.use(habitRoutes);
app.use(pushRoutes);
app.use(settingsRoutes);

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

configurePush();
connectDB(process.env.MONGODB_URI)
  .then(() => {
    app.listen(PORT, () => console.log(`Questly on http://localhost:${PORT}`));
    if (configurePush()) startReminders();
  })
  .catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });