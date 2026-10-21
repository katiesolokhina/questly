const User = require('../models/User');

// Loads the signed-in user onto req.user / res.locals, or sends them to /login.
async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    return res.redirect('/login');
  }
  try {
    const user = await User.findById(req.session.userId);
    // Deleted or disabled while signed in: end the session.
    if (!user || user.disabled) return req.session.destroy(() => res.redirect('/login'));
    req.user = user;
    res.locals.user = user;
    res.locals.theme = user.theme && user.theme !== 'system' ? user.theme : '';
    next();
  } catch (err) {
    next(err);
  }
}

// Use after requireAuth.
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(404).send('Not found'); // don't reveal admin pages exist
}

// CSRF guard: reject state-changing requests sent from another site.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || origin === process.env.APP_ORIGIN) return next();
  console.warn(`Blocked origin: "${origin}" (expected "${process.env.APP_ORIGIN}")`);
  return res.status(403).send('Forbidden');
}

module.exports = { requireAuth, requireAdmin, sameOrigin };
