/**
 * One-time (safe to re-run): create the collections and unique indexes in MONGODB_DB_NAME and the
 * default settings document. Run: npx tsx scripts/init-db.ts
 */
import 'dotenv/config';
import dns from 'node:dns';
import mongoose from 'mongoose';
import { loadConfig } from '../src/config.js';
import { Settings } from '../src/models/Settings.js';
import { User } from '../src/models/User.js';

const config = loadConfig();
const opts = { dbName: config.MONGODB_DB_NAME, serverSelectionTimeoutMS: 15_000 };
try {
  await mongoose.connect(config.MONGODB_URI, opts);
} catch {
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(config.MONGODB_URI, opts);
}
await User.init(); // creates "users" + unique indexes (firebaseUid, accountId, referralCode)
await Settings.updateOne(
  { _id: 'global' },
  { $setOnInsert: { supportWhatsApp: '', trialDays: config.TRIAL_DAYS, referralRate: 0.2, paymentNumbers: { bkash: '', nagad: '', bank: '' }, telegramChatIds: [], updatedBy: 'init' } },
  { upsert: true },
);
const cols = (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name);
const idx = (await User.collection.indexes()).map((i) => i.name);
console.log(`database: ${mongoose.connection.name}`);
console.log(`collections: ${cols.join(', ')}`);
console.log(`users indexes: ${idx.join(', ')}`);
await mongoose.disconnect();
