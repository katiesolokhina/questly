// Asks before submitting any form marked with data-confirm (used by "Archive this habit").
// Lives in a file, not inline, because Helmet's CSP blocks inline scripts.
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});

// Daily rating: suggested labels follow "1 is a good day" / "5 is a good day".
const labels = document.querySelector('.rating-labels[data-low]');
if (labels) {
  const low = labels.dataset.low.split('|');
  const inputs = labels.querySelectorAll('input');
  document.querySelectorAll('input[name="ratingDir"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const list = radio.value === 'low' ? low : [...low].reverse();
      inputs.forEach((input, i) => { input.placeholder = list[i]; });
    });
  });
}
