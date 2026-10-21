const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    // IANA zone; "today" is always computed in this zone, never in server time.
    timezone: { type: String, default: 'America/Chicago' },
    // Appearance: 'system' follows the device; 'light'/'dark' override it everywhere.
    theme: { type: String, enum: ['system', 'light', 'dark'], default: 'system' },
    // admin can invite family members and manage accounts, but never sees their data.
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    // Disabled accounts can't sign in; their data is kept until deleted.
    disabled: { type: Boolean, default: false },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Sunday 7 PM summary push. weeklySentFor = the Sunday it last went out (once per week).
    weeklySummary: { type: Boolean, default: true },
    weeklySentFor: { type: String },
    // Pollen location (optional). Rounded to 2 decimals (~1 km); never a street address.
    pollen: {
      label: { type: String, trim: true, maxlength: 80 },
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
    },
  },
  { timestamps: true }
);

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, 12);
};

module.exports = mongoose.model('User', userSchema);
