// Share / Copy buttons for one-time links in Settings → Family.
(function () {
  const say = (btn, text) => {
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = original; }, 1800);
  };

  document.querySelectorAll('[data-copy-link]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copyLink);
        say(btn, 'Copied');
      } catch {
        const input = document.querySelector('[data-link-input]');
        if (input) { input.focus(); input.select(); }
        say(btn, 'Select and copy');
      }
    });
  });

  document.querySelectorAll('[data-share-link]').forEach((btn) => {
    if (!navigator.share) { btn.hidden = true; return; } // desktop: Copy only
    btn.addEventListener('click', () => {
      navigator.share({ title: 'Questly', text: 'Here’s your Questly link:', url: btn.dataset.shareLink }).catch(() => {});
    });
  });
})();
