const mongoose = require('mongoose');

// A free-text note for one habit on one day (symptoms, context). Independent of check-ins,
// so a missed day can have a note too.
const dayNoteSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    habitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Habit', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    text: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

dayNoteSchema.index({ habitId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DayNote', dayNoteSchema);
