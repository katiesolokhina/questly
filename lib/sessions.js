const mongoose = require('mongoose');

// connect-mongo stores each session as a JSON string containing "userId":"<id>".
// Deletes all of a user's sessions (optionally keeping one), which signs them out everywhere.
async function deleteUserSessions(userId, exceptSessionId) {
  const filter = { session: { $regex: `"userId":"${String(userId)}"` } };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  await mongoose.connection.collection('sessions').deleteMany(filter);
}

module.exports = { deleteUserSessions };
