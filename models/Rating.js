const mongoose = require('mongoose');

// A 1–5 score for one habit on one day ("How are your symptoms today?").
// Independent of check-ins: a missed day can be rated too, which is often the interesting part.
const ratingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    habitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Habit', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    score: { type: Number, required: true, min: 1, max: 5 },
  },
  { timestamps: true }
);

ratingSchema.index({ habitId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Rating', ratingSchema);
