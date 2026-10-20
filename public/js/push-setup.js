// "Reminders on this device" card on the dashboard.
// States: unsupported (card stays hidden) · off · on · blocked.
(function () {
  const card = document.getElementById('push-card');
  if (!card) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

  const $ = (sel) => card.querySelector(sel);
  const show = (state) => {
    card.hidden = false;
    card.querySelectorAll('[data-state]').forEach((el) => { el.hidden = el.dataset.state !== state; });
  };
  const say = (text) => { $('[data-status]').textContent = text; };

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

  $('[data-action="enable"]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return refresh();
      const { publicKey } = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
      await post('/api/push/subscribe', sub.toJSON());
      show('on');
      say('Reminders are on. Set a time in each habit’s settings.');
    } catch (err) {
      console.warn(err);
      say('Could not turn on reminders. Try again.');
    } finally {
      e.currentTarget.disabled = false;
    }
  });

  $('[data-action="test"]').addEventListener('click', async () => {
    try {
      const { sent } = await post('/api/push/test');
      say(sent ? 'Test sent. It should arrive in a few seconds.' : 'No devices found. Turn reminders on again.');
    } catch (err) {
      say('Test failed. Check the server log.');
    }
  });

  $('[data-action="disable"]').addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    say('Reminders are off on this device.');
    show('off');
  });

  refresh().catch((err) => console.warn('Push setup failed:', err));
})();
