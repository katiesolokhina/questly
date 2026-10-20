const mongoose = require('mongoose');

async function connectDB(uri) {
  if (!uri) throw new Error('MONGODB_URI is not set');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log(`MongoDB connected: ${mongoose.connection.name}`);
  return mongoose.connection;
}

module.exports = { connectDB };