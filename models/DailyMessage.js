const mongoose = require('mongoose');

// One cached quote + one cached advice per user per day,
// so API Ninjas gets called at most twice a day per user.
const dailyMessageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    items: [
      {
        _id: false,
        type: { type: String, enum: ['quote', 'advice'] },
        text: String,
        author: String,
        source: { type: String, enum: ['api', 'fallback'] },
      },
    ],
  },
  { timestamps: true }
);

dailyMessageSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyMessage', dailyMessageSchema);