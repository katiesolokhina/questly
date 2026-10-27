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
    // Free-text details shown under the title, e.g. "3 drops under the tongue".
    description: { type: String, trim: true, maxlength: 300, default: '' },
    // Optional link, e.g. to the prescriber's account page. http(s) only (validated in the route).
    link: {
      url: { type: String, trim: true, maxlength: 500, default: '' },
      label: { type: String, trim: true, maxlength: 40, default: '' },
    },
    // Pauses (travel, sick, doctor's break): days inside count as off days. Inclusive local dates.
    pauses: [
      {
        from: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        to: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        reason: { type: String, enum: ['travel', 'sick', 'doctor', 'other'], default: 'other' },
      },
    ],
    // Supply countdown (e.g. doses left in a bottle). `base` is the amount at `baseAt`
    // (last refill or correction); what's left is derived from check-ins since then.
    supply: {
      enabled: { type: Boolean, default: false },
      unit: { type: String, trim: true, maxlength: 20, default: 'doses' },
      perCheckin: { type: Number, min: 1, max: 1000, default: 1 },
      size: { type: Number, min: 1, max: 100000, default: 30 },
      base: { type: Number, min: 0, max: 1000000, default: 0 },
      baseAt: { type: Date },
      baseDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      warnDays: { type: Number, min: 0, max: 60, default: 7 },
      reorderUrl: { type: String, trim: true, maxlength: 500, default: '' },
      lowSentFor: { type: Date }, // the baseAt we already sent a "running low" push for
    },
    // Count-up goal (e.g. 1,095 days, 30 workouts, 2,000 pages).
    goal: {
      enabled: { type: Boolean, default: false },
      label: { type: String, trim: true, maxlength: 40, default: '' },
      unit: { type: String, trim: true, maxlength: 20, default: 'check-ins' },
      perCheckin: { type: Number, min: 1, max: 1000, default: 1 },
      target: { type: Number, min: 1, max: 1000000 },
      from: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      by: { type: String, enum: ['checkins', 'minutes'], default: 'checkins' }, // minutes = stopwatch time
      celebrated: { type: Boolean, default: false }, // "Goal reached" shown; reset when the goal changes
    },
    // Daily 1–5 rating with its own question and labels. lowIsGood: 1 is the best day
    // (symptoms: Clear … Severe); otherwise 5 is (mood: Rough … Great).
    rating: {
      enabled: { type: Boolean, default: false },
      question: { type: String, trim: true, maxlength: 80, default: '' },
      labels: { type: [{ type: String, trim: true, maxlength: 16 }], default: undefined },
      lowIsGood: { type: Boolean },
    },
    // Timer: countdown (hold drops 30 s, then check in automatically) or stopwatch (time a workout;
    // the time is saved with the check-in). seconds = countdown length.
    timer: {
      mode: { type: String, enum: ['off', 'countdown', 'stopwatch'], default: 'off' },
      seconds: { type: Number, min: 5, max: 5400, default: 30 },
    },
    // Show pollen on this habit (chip + chart line). Unset = on for medications, off for habits.
    showPollen: { type: Boolean },
    // Milestones: badge levels already celebrated, so each celebration shows once.
    // `seen` stays unset until first computed; existing badges are then marked seen silently.
    milestones: {
      enabled: { type: Boolean, default: true },
      seen: { type: [Number], default: undefined },
    },
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

// The pause covering a local date, if any.
habitSchema.methods.pauseOn = function (date) {
  return (this.pauses || []).find((p) => date >= p.from && date <= p.to) || null;
};

habitSchema.statics.PAUSE_REASONS = { travel: 'Travel', sick: 'Sick', doctor: 'Doctor’s break', other: 'Break' };

habitSchema.statics.ICONS = ICONS;

module.exports = mongoose.model('Habit', habitSchema);
