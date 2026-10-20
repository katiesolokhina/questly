const mongoose = require('mongoose');

const ICONS = ['drop', 'pill', 'dumbbell', 'book', 'leaf', 'heart'];

const habitSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    kind: { type: String, enum: ['medication', 'habit'], default: 'habit' },
    icon: { type: String, enum: ICONS, default: 'leaf' },
    // every=true → daily. Otherwise only `days` (0 = Sunday … 6 = Saturday) are scheduled.
    // Unscheduled days are "off days": never missed, never break a streak.
    schedule: {
      every: { type: Boolean, default: true },
      days: {
        type: [Number],
        default: [0, 1, 2, 3, 4, 5, 6],
        validate: (v) => v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      },
    },
    // Local date (YYYY-MM-DD). Days before this never count as missed.
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    archived: { type: Boolean, default: false },
    // Push reminder at a local time ("HH:MM"), only if not checked in yet.
    // Medications also get one follow-up nudge 2 hours later.
    reminder: {
      enabled: { type: Boolean, default: false },
      time: { type: String, default: '09:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    },
  },
  { timestamps: true }
);

habitSchema.methods.isScheduledOn = function (dow) {
  return this.schedule.every || this.schedule.days.includes(dow);
};

habitSchema.statics.ICONS = ICONS;

module.exports = mongoose.model('Habit', habitSchema);
