// Registers the service worker that makes Questly installable.
// In a file, not inline, because Helmet's CSP blocks inline scripts.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker failed:', err));
  });
}
