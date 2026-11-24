/** Server entry: load config → connect MongoDB → init Firebase Admin → listen. */
import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { makeTelegram } from './lib/telegram.js';

const config = loadConfig();

initializeApp({
  credential: cert({
    projectId: config.FIREBASE_PROJECT_ID,
    clientEmail: config.FIREBASE_CLIENT_EMAIL,
    privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const auth = getAuth();

await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
console.log('[db] connected');

const app = createApp({
  config,
  // checkRevoked: a user signed out everywhere / disabled in Firebase is rejected at once
  verifyToken: (token) => auth.verifyIdToken(token, true),
  telegram: makeTelegram(config),
});

const server = app.listen(config.PORT, () => console.log(`[api] listening on :${config.PORT}`));

const shutdown = () => {
  server.close(() => void mongoose.disconnect().then(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
