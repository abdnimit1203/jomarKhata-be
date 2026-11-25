/**
 * Cloud backup of the khata (signed-in users).
 *   PUT  /me/backup        { encoding, payload, size, shopName?, appVersion? } → saved; the old one
 *                          becomes `previous`. Max ~4 MB per upload (Vercel's body limit is 4.5 MB).
 *   GET  /me/backup/meta   { exists, savedAt, size, shopName, appVersion } (no payload — cheap check)
 *   GET  /me/backup        { encoding, payload, … } the latest copy, for restoring on a phone
 */
import express, { type Express, type RequestHandler } from 'express';
import { z } from 'zod';
import { CloudBackup } from '../models/CloudBackup.js';
import type { UserDoc } from '../models/User.js';

const MAX_PAYLOAD = 4_000_000;

const input = z.object({
  encoding: z.enum(['gzip-base64', 'plain']),
  payload: z.string().min(10).max(MAX_PAYLOAD, 'খাতা অনেক বড় — ফাইল ব্যাকআপ নিন।'),
  size: z.number().int().min(1),
  shopName: z.string().trim().max(120).default(''),
  appVersion: z.string().trim().max(40).default(''),
});

type Req = { user: UserDoc; body: unknown };

/** Parser for this route only (the rest of the API keeps the 1 MB limit). Mount BEFORE express.json(). */
export const backupBodyParser = express.json({ limit: '4500kb' });

export function registerBackupRoutes(app: Express, userGuard: RequestHandler[]) {
  app.put('/me/backup', ...userGuard, async (req, res) => {
    const { user } = req as unknown as Req;
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'তথ্য ঠিক নেই।' });
    const now = new Date();
    const existing = await CloudBackup.findOne({ userId: user._id }, { current: 1 }).lean<{ current?: unknown }>();
    await CloudBackup.updateOne(
      { userId: user._id },
      { $set: { accountId: user.accountId, current: { ...parsed.data, savedAt: now }, previous: existing?.current ?? null } },
      { upsert: true },
    );
    res.json({ ok: true, savedAt: now.toISOString() });
  });

  app.get('/me/backup/meta', ...userGuard, async (req, res) => {
    const { user } = req as unknown as Req;
    const doc = await CloudBackup.findOne({ userId: user._id }, { 'current.payload': 0, previous: 0 }).lean<{
      current?: { savedAt: Date; size: number; shopName: string; appVersion: string };
    }>();
    if (!doc?.current) return res.json({ exists: false });
    const { savedAt, size, shopName, appVersion } = doc.current;
    res.json({ exists: true, savedAt, size, shopName, appVersion });
  });

  app.get('/me/backup', ...userGuard, async (req, res) => {
    const { user } = req as unknown as Req;
    const doc = await CloudBackup.findOne({ userId: user._id }, { current: 1 }).lean<{ current?: unknown }>();
    if (!doc?.current) return res.status(404).json({ error: 'no_backup', message: 'ক্লাউডে কোনো ব্যাকআপ নেই।' });
    res.set('cache-control', 'no-store');
    res.json(doc.current);
  });
}
