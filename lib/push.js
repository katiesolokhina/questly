const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

let configured = false;

// Returns true if VAPID keys are present. Without them, push is simply off.
function configurePush() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    console.warn('Push disabled: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in .env');
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

// Sends one notification to every device the user turned reminders on for.
// Devices that unsubscribed or uninstalled (404/410) are removed automatically.
async function sendToUser(userId, payload) {
  if (!configured) return 0;
  const subs = await PushSubscription.find({ userId });
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub.toWebPush(), JSON.stringify(payload), { TTL: 60 * 60 });
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.warn(`Push failed (${err.statusCode || err.message}) for ${sub.endpoint.slice(0, 40)}…`);
        }
      }
    })
  );
  return sent;
}

module.exports = { configurePush, sendToUser, isPushConfigured: () => configured };
