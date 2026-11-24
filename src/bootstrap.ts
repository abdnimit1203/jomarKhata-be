/**
 * Builds the app once per process: config → Firebase Admin → MongoDB → Express.
 * Used by both entry points:
 *   - src/index.ts   a normal long-running server (Render / Railway / VPS, and `npm run dev`)
 *   - api/index.ts   a Vercel serverless function (free hosting; one instance may serve many requests)
 * The MongoDB connection is reused between requests on a warm instance.
 */
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { makeTelegram } from './lib/telegram.js';

let ready: Promise<ReturnType<typeof createApp>> | null = null;

async function init() {
  const config = loadConfig();
  if (getApps().length === 0) {
    initializeApp({
      credential: cert({
        projectId: config.FIREBASE_PROJECT_ID,
        clientEmail: config.FIREBASE_CLIENT_EMAIL,
        privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 5 });
    console.log('[db] connected');
  }
  const auth = getAuth();
  return createApp({
    config,
    // checkRevoked: a user signed out everywhere / disabled in Firebase is rejected at once
    verifyToken: (token) => auth.verifyIdToken(token, true),
    telegram: makeTelegram(config),
  });
}

export function getApp() {
  ready ??= init().catch((err) => {
    ready = null; // let the next request try again (e.g. DB was briefly unreachable)
    throw err;
  });
  return ready;
}
