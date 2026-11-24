/**
 * Builds the app once per process: config → Firebase Admin → MongoDB → Express.
 * Used by src/index.ts — Vercel zero-config (default export) and a normal server (`npm run dev` /
 * `npm start`). The MongoDB connection is reused between requests on a warm instance.
 */
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import * as dns from 'node:dns';
import mongoose from 'mongoose';
import { createApp } from './createApp.js';
import { loadConfig } from './config.js';
import { makeTelegram } from './lib/telegram.js';

let ready: Promise<ReturnType<typeof createApp>> | null = null;

/**
 * The PEM key as pasted into a hosting dashboard often keeps the .env quotes or real line breaks
 * (dashboards don't parse like dotenv). Tolerate stray whitespace, wrapping quotes, CRLF and
 * literal "\n" sequences.
 */
export function cleanPrivateKey(raw: string): string {
  return raw
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n');
}

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
        privateKey: cleanPrivateKey(config.FIREBASE_PRIVATE_KEY),
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
