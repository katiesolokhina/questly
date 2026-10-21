// "Use my location" for the pollen setting: asks the browser once, rounds to ~1 km, submits.
(() => {
  const btn = document.getElementById('use-location');
  if (!btn || !('geolocation' in navigator)) return;
  const form = btn.closest('form');
  const status = document.getElementById('location-status');
  btn.hidden = false;
  btn.addEventListener('click', () => {
    status.textContent = 'Finding you…';
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        form.elements.lat.value = pos.coords.latitude.toFixed(2);
        form.elements.lng.value = pos.coords.longitude.toFixed(2);
        form.elements.place.value = '';
        form.submit();
      },
      () => {
        status.textContent = 'Couldn’t get your location. Type your city instead.';
        btn.disabled = false;
      },
      { maximumAge: 60 * 60 * 1000, timeout: 10000 }
    );
  });
})();
