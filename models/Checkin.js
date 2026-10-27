const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['quote', 'advice'] },
    text: String,
    author: String,
  },
  { _id: false }
);

const checkinSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    habitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Habit', required: true },
    // Local calendar date in the user's timezone, stored as a string on purpose:
    // a Date would be UTC and an 8pm Dallas check-in would land on tomorrow.
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    checkedInAt: { type: Date, default: Date.now },
    // live = tapped on the day · import = seeded history · backfill = added later from the calendar
    source: { type: String, enum: ['live', 'import', 'backfill'], default: 'live' },
    // The quote/advice shown for this check-in, frozen so a reload shows the same one.
    message: { type: messageSchema, default: undefined },
    // Seconds timed with the stopwatch (sessions on the same day add up). Unset when not timed.
    duration: { type: Number, min: 0, max: 86400 },
  },
  { timestamps: true }
);

// One check-in per habit per day.
checkinSchema.index({ habitId: 1, date: 1 }, { unique: true });
checkinSchema.index({ userId: 1, date: 1 });

module.exports = mongoose.model('Checkin', checkinSchema);
