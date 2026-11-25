/**
 * Sends a SAMPLE alert to the Telegram chats in the dashboard settings, to check how messages look.
 * Nothing is written to the database. Run: npx tsx scripts/test-telegram.ts [payment|user|report]
 */
import 'dotenv/config';
import * as dns from 'node:dns';
import mongoose from 'mongoose';
import { adminUrl, list, loadConfig } from '../src/config.js';
import { renderAlert, makeTelegram, type Alert } from '../src/lib/telegram.js';
import { getSettings } from '../src/models/Settings.js';

const config = loadConfig();
const opts = { dbName: config.MONGODB_DB_NAME, serverSelectionTimeoutMS: 15_000 };
try {
  await mongoose.connect(config.MONGODB_URI, opts);
} catch {
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(config.MONGODB_URI, opts);
}
const s = await getSettings({ telegramChatIds: list(config.TELEGRAM_ADMIN_CHAT_ID) });
const ADMIN = adminUrl(config);
const kind = process.argv[2] ?? 'payment';

const samples: Record<string, Alert> = {
  payment: {
    title: '💰 NEW PAYMENT REQUEST (TEST)',
    rows: [
      ['Name', 'রহিম জেনারেল স্টোর'],
      ['User ID', 'JK-4821-0937'],
      ['Email', 'rahim.test@example.com'],
      ['Plan', '180 days'],
      ['Amount', '৳999'],
      ['Method', 'bKash'],
      ['Paid from', '01711000000'],
      ['TrxID', 'TEST9X7K2M'],
    ],
    button: { text: 'Review request', url: `${ADMIN}/payments?q=TEST9X7K2M` },
  },
  user: {
    title: '🆕 NEW USER (TEST)',
    rows: [['Name', 'Rahim'], ['User ID', 'JK-4821-0937'], ['Email', 'rahim.test@example.com'], ['Login', 'Google'], ['Trial', `${s.trialDays} days`]],
    button: { text: 'View user', url: `${ADMIN}/users/JK-4821-0937` },
  },
  report: {
    title: '🐞 NEW ISSUE REPORT (TEST)',
    rows: [['Name', 'Rahim'], ['User ID', 'JK-4821-0937'], ['Phone', '01711000000'], ['Page', '/app · sales'], ['App', '0.4.0']],
    body: 'বিক্রি সেভ করলে কিছু হয় না',
    button: { text: 'View report', url: `${ADMIN}/reports` },
  },
};

console.log(`chats: ${s.telegramChatIds.length}, admin link: ${ADMIN}`);
console.log(renderAlert(samples[kind]).text);
await makeTelegram(config).notify(samples[kind], s.telegramChatIds);
await mongoose.disconnect();
