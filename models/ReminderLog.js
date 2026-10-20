const mongoose = require('mongoose');

// Records each reminder sent, so it goes out exactly once per habit per day,
// even across restarts. Old rows delete themselves after 30 days.
const reminderLogSchema = new mongoose.Schema({
  habitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Habit', required: true },
  date: { type: String, required: true },
  kind: { type: String, enum: ['first', 'followup'], required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

reminderLogSchema.index({ habitId: 1, date: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('ReminderLog', reminderLogSchema);
