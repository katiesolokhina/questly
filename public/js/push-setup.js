// Reminders on this device. Drives two optional pieces of UI:
//  - #push-bell  (dashboard header): shows state; off → one-tap enable; on/blocked → opens Settings
//  - #push-card  (Settings → Notifications): turn on, send a test, turn off
// If the browser can't do push at all, both stay hidden.
(function () {
  const bell = document.getElementById('push-bell');
  const card = document.getElementById('push-card');
  if (!bell && !card) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

  const SETTINGS = '/settings#notifications';
  const LABELS = {
    on: 'Reminders are on. Open notification settings',
    off: 'Turn on reminders',
    blocked: 'Notifications are blocked. Open notification settings',
  };
  let state = null;

  function show(next) {
    state = next;
    if (bell) {
      bell.hidden = false;
      bell.dataset.state = next;
      bell.setAttribute('aria-label', LABELS[next]);
      bell.title = LABELS[next];
    }
    if (card) {
      card.hidden = false;
      card.querySelectorAll('[data-state]').forEach((el) => { el.hidden = el.dataset.state !== next; });
    }
  }
  function say(text) {
    const status = card && card.querySelector('[data-status]');
    if (status) status.textContent = text;
  }

  function keyToBytes(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  }

  async function refresh() {
    if (Notification.permission === 'denied') return show('blocked');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/api/push/subscribe', sub.toJSON()); // re-sync in case the server lost it
      return show('on');
    }
    show('off');
  }

  async function enable() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { await refresh(); return false; }
    const { publicKey } = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
    await post('/api/push/subscribe', sub.toJSON());
    show('on');
    return true;
  }

  async function disable() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    show('off');
  }

  if (bell) {
    bell.addEventListener('click', async () => {
      if (state !== 'off') { window.location.href = SETTINGS; return; } // never turn off by accident
      bell.disabled = true;
      try { await enable(); } catch (err) { console.warn(err); window.location.href = SETTINGS; }
      finally { bell.disabled = false; }
    });
  }

  if (card) {
    const on = (action, fn) => {
      const btn = card.querySelector(`[data-action="${action}"]`);
      if (btn) btn.addEventListener('click', fn);
    };
    on('enable', async (e) => {
      e.currentTarget.disabled = true;
      try {
        if (await enable()) say('Reminders are on. Set a time in each habit’s settings.');
      } catch (err) {
        console.warn(err);
        say('Could not turn on reminders. Try again.');
      } finally {
        e.currentTarget.disabled = false;
      }
    });
    on('test', async () => {
      try {
        const { sent } = await post('/api/push/test');
        say(sent ? 'Test sent. It should arrive in a few seconds.' : 'No devices found. Turn reminders on again.');
      } catch {
        say('Test failed. Check the server log.');
      }
    });
    on('disable', async () => {
      await disable();
      say('Reminders are off on this device.');
    });
  }

  refresh().catch((err) => console.warn('Push setup failed:', err));
})();
