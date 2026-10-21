// Fills the hidden timezone field so a new account's "today" matches their location.
(function () {
  const field = document.querySelector('input[name="timezone"]');
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (field && tz) field.value = tz;
  } catch { /* server falls back to America/Chicago */ }
})();
