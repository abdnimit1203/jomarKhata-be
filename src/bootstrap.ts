/**
 * Builds the app once per process: config → Firebase Admin → MongoDB → Express.
 * Used by both entry points:
 *   - src/index.ts   a normal long-running server (Render / Railway / VPS, and `npm run dev`)
 *   - api/index.ts   a Vercel serverless function (free hosting; one instance may serve many requests)
 * The MongoDB connection is reused between requests on a warm instance.
 */
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import dns from 'node:dns';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { makeTelegram } from './lib/telegram.js';

let ready: Promise<ReturnType<typeof createApp>> | null = null;

/**
 * `mongodb+srv://` needs a DNS SRV lookup. Some ISPs' DNS refuse it (seen in Bangladesh:
 * "querySrv ECONNREFUSED"). In that case retry once through public DNS (Cloudflare, Google).
 */
async function connectDb(uri: string, dbName: string) {
  const opts = { dbName, serverSelectionTimeoutMS: 10_000, maxPoolSize: 5 };
  try {
    await mongoose.connect(uri, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/querySrv|ENOTFOUND|ECONNREFUSED/.test(msg) || !uri.startsWith('mongodb+srv://')) throw err;
    console.warn('[db] SRV lookup failed with the system DNS; retrying through public DNS');
    dns.setServers(['1.1.1.1', '8.8.8.8']);
    await mongoose.connect(uri, opts);
  }
  console.log(`[db] connected (${dbName})`);
}

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
  if (mongoose.connection.readyState !== 1) await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME);
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
