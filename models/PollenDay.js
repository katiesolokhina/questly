const mongoose = require('mongoose');

// Pollen index for one place (rounded to ~1 km) on one day, from Google's Pollen API.
// Values are the Universal Pollen Index, 0 (none) to 5 (very high); null = no data that day.
// Each fetch stores today plus the next 4 days; a day keeps its last forecast once it's past.
const pollenDaySchema = new mongoose.Schema({
  place: { type: String, required: true }, // "32.78,-96.80"
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  tree: { type: Number, min: 0, max: 5, default: null },
  grass: { type: Number, min: 0, max: 5, default: null },
  weed: { type: Number, min: 0, max: 5, default: null },
  overall: { type: Number, min: 0, max: 5, default: null },
  top: { type: String, default: '' }, // "Tree"
  fetchedOn: { type: String, required: true }, // the day this row was last refreshed
});

pollenDaySchema.index({ place: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('PollenDay', pollenDaySchema);
