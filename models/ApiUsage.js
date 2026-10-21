const mongoose = require('mongoose');

// Paid-API calls per UTC day, so a bug can never run up a bill: callers claim a slot first.
const apiUsageSchema = new mongoose.Schema({
  api: { type: String, required: true },
  date: { type: String, required: true },
  count: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 60 },
});

apiUsageSchema.index({ api: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('ApiUsage', apiUsageSchema);
