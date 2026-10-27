// Habit timer on the dashboard.
//  countdown: Start → counts down → chime + vibrate → checks in automatically (Undo is on the next screen).
//  stopwatch: Start / Pause / Resume → "Finish & check in" posts the seconds with the check-in.
// Time is computed from timestamps saved in localStorage, so it stays right when the phone locks,
// the tab sleeps, or the page reloads. The screen is kept awake while a timer runs, where supported.
(() => {
  const card = document.querySelector('[data-timer]');
  if (!card) return;

  const mode = card.dataset.mode;
  const total = Number(card.dataset.seconds) || 30;
  const KEY = `questly-timer-${card.dataset.habit}`;
  const STALE_MS = 10 * 60 * 1000; // a countdown that ended more than 10 min ago is dropped, not logged
  const $ = (sel) => card.querySelector(sel);
  const timeEl = $('[data-time]');
  const bar = $('[data-bar]'); // countdown only: a stopwatch has no end to fill toward
  const sub = $('[data-sub]');
  const subIdle = sub ? sub.textContent.trim() : '';
  const announce = $('[data-announce]');
  const form = $('[data-timer-form]');
  const btn = (act) => $(`[data-act="${act}"]`);
  const baseTitle = document.title;

  let state = load(); // { start, pausedMs, pausedAt }
  let tick = null;
  let wakeLock = null;
  let audio = null;
  let done = false;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      return s && s.mode === mode ? s : null;
    } catch { return null; }
  }
  function save() {
    try {
      if (state) localStorage.setItem(KEY, JSON.stringify(state));
      else localStorage.removeItem(KEY);
    } catch { /* private mode: timer still works while the page is open */ }
  }

  function elapsedMs(now = Date.now()) {
    if (!state) return 0;
    const pausedNow = state.pausedAt ? now - state.pausedAt : 0;
    return Math.max(0, now - state.start - state.pausedMs - pausedNow);
  }

  function fmt(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  function show(acts) {
    ['start', 'pause', 'resume', 'finish', 'cancel'].forEach((a) => { const b = btn(a); if (b) b.hidden = !acts.includes(a); });
  }

  function render() {
    const el = elapsedMs() / 1000;
    if (mode === 'countdown') {
      const left = Math.max(0, total - el);
      timeEl.textContent = fmt(Math.ceil(left));
      bar.style.width = `${Math.min(100, (el / total) * 100)}%`;
      if (state) document.title = `${fmt(Math.ceil(left))} · ${baseTitle}`;
      if (state && left <= 0) finishCountdown();
    } else {
      timeEl.textContent = fmt(Math.floor(el));
      if (sub) {
        sub.textContent = !state ? subIdle : state.pausedAt ? 'Paused' : 'Running';
        sub.classList.toggle('timer-live', Boolean(state && !state.pausedAt));
      }
      if (state) document.title = `${fmt(Math.floor(el))}${state.pausedAt ? ' (paused)' : ''} · ${baseTitle}`;
    }
  }

  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  }

  function running(on) {
    card.classList.toggle('is-running', on);
    clearInterval(tick);
    if (on) tick = setInterval(render, 250);
    keepAwake(on && !(state && state.pausedAt));
    render();
  }

  function chime() {
    try {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      if (!audio) return;
      const now = audio.currentTime;
      [0, 0.25].forEach((t) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, now + t);
        g.gain.exponentialRampToValueAtTime(0.3, now + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.2);
        o.connect(g).connect(audio.destination);
        o.start(now + t);
        o.stop(now + t + 0.22);
      });
    } catch { /* sound is a nicety */ }
  }

  function submit(durationSec) {
    form.elements.duration.value = durationSec ? String(durationSec) : '';
    state = null;
    save();
    form.submit();
  }

  function finishCountdown() {
    if (done) return;
    done = true;
    clearInterval(tick);
    keepAwake(false);
    timeEl.textContent = '0:00';
    announce.textContent = 'Time’s up. Checking in.';
    chime();
    setTimeout(() => submit(0), 600); // let the chime play
  }

  function start() {
    // Audio must be unlocked by a tap; the chime plays later.
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
    state = { mode, start: Date.now(), pausedMs: 0, pausedAt: null };
    save();
    show(mode === 'countdown' ? ['cancel'] : ['pause', 'finish', 'cancel']);
    announce.textContent = mode === 'countdown' ? `Countdown started, ${fmt(total)}.` : 'Stopwatch started.';
    running(true);
  }

  btn('start').addEventListener('click', start);
  btn('cancel').addEventListener('click', () => {
    state = null;
    save();
    document.title = baseTitle;
    show(['start']);
    announce.textContent = 'Timer cancelled.';
    running(false);
    timeEl.textContent = mode === 'countdown' ? fmt(total) : '0:00';
    if (bar) bar.style.width = '0';
    if (sub) { sub.textContent = subIdle; sub.classList.remove('timer-live'); }
  });
  if (btn('pause')) btn('pause').addEventListener('click', () => {
    state.pausedAt = Date.now();
    save();
    show(['resume', 'finish', 'cancel']);
    announce.textContent = 'Paused.';
    keepAwake(false);
    render();
  });
  if (btn('resume')) btn('resume').addEventListener('click', () => {
    state.pausedMs += Date.now() - state.pausedAt;
    state.pausedAt = null;
    save();
    show(['pause', 'finish', 'cancel']);
    announce.textContent = 'Resumed.';
    keepAwake(true);
    render();
  });
  if (btn('finish')) btn('finish').addEventListener('click', () => {
    const secs = Math.floor(elapsedMs() / 1000); // same rounding as the display: what you see is what's saved
    if (secs < 1) return;
    clearInterval(tick);
    keepAwake(false);
    submit(secs);
  });

  // The wake lock is dropped whenever the page is hidden; take it back on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state && !state.pausedAt) keepAwake(true);
    if (document.visibilityState === 'visible') render();
  });

  // Resume a timer that was running before a reload or a locked screen.
  card.hidden = false;
  if (state) {
    if (mode === 'countdown' && elapsedMs() / 1000 >= total) {
      const endedAgo = elapsedMs() - total * 1000;
      if (endedAgo > STALE_MS) { state = null; save(); show(['start']); render(); return; }
      show(['cancel']);
      finishCountdown();
      return;
    }
    show(mode === 'countdown' ? ['cancel'] : state.pausedAt ? ['resume', 'finish', 'cancel'] : ['pause', 'finish', 'cancel']);
    running(true);
  } else {
    show(['start']);
  }
})();
