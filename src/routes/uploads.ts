/**
 * Image uploads (ImageKit). The browser compresses the image, asks here for short-lived signed
 * params, uploads straight to ImageKit under /jomarkhata/..., then saves the returned URL here.
 *   GET  /uploads/imagekit-auth?purpose=avatar|qr   signed params (avatar: max AVATAR_PER_DAY a day;
 *                                                    qr: super admin only)
 *   PUT  /me/avatar          { url, fileId } | { url: '' } — the old photo is deleted from ImageKit
 *   PUT  /admin/payment-qr   { method: 'bkash'|'nagad', url, fileId } | { url: '' } — old QR deleted
 * Only URLs inside our own ImageKit folder are accepted.
 */
import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { ImageKitApi } from '../lib/imagekit.js';
import { Settings, type SettingsValue } from '../models/Settings.js';
import { User, type UserDoc } from '../models/User.js';

export const AVATAR_PER_DAY = 5;

type Req = { user: UserDoc; body: unknown; query: Record<string, unknown> };
const dhakaDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

const saveInput = z.union([
  z.object({ url: z.literal('') }),
  z.object({ url: z.string().url().max(500), fileId: z.string().min(1).max(100) }),
]);

export function registerUploadRoutes(
  app: Express,
  userGuard: RequestHandler[],
  superAdmin: RequestHandler,
  deps: { imagekit: ImageKitApi; settings: () => Promise<SettingsValue> },
) {
  const { imagekit } = deps;
  const off = { error: 'uploads_off', message: 'ছবি আপলোড এখন চালু নেই।' };

  app.get('/uploads/imagekit-auth', ...userGuard, async (req, res) => {
    const { user, query } = req as unknown as Req;
    if (!imagekit.enabled) return res.status(503).json(off);
    if (query.purpose === 'qr') {
      if (user.role !== 'super_admin') return res.status(403).json({ error: 'forbidden' });
      return res.json(imagekit.authParams());
    }
    // avatar: count today's signatures atomically, refuse over the limit
    const day = dhakaDay();
    const updated = await User.findOneAndUpdate(
      { _id: user._id, $or: [{ 'avatarUploads.day': { $ne: day } }, { 'avatarUploads.count': { $lt: AVATAR_PER_DAY } }] },
      [{ $set: { avatarUploads: { day, count: { $cond: [{ $eq: ['$avatarUploads.day', day] }, { $add: ['$avatarUploads.count', 1] }, 1] } } } }],
      { returnDocument: 'after', updatePipeline: true },
    );
    if (!updated) return res.status(429).json({ error: 'too_many', message: `আজ ${AVATAR_PER_DAY} বার ছবি বদলানো হয়ে গেছে। কাল আবার চেষ্টা করুন।` });
    res.json(imagekit.authParams());
  });

  app.put('/me/avatar', ...userGuard, async (req, res) => {
    const { user } = req as unknown as Req;
    const parsed = saveInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid' });
    const next = parsed.data;
    if (next.url && !imagekit.isOurFile(next.url, '/avatars')) return res.status(400).json({ error: 'not_our_file' });
    const oldId = user.avatarFileId;
    const fileId = 'fileId' in next ? next.fileId : '';
    await User.updateOne({ _id: user._id }, { $set: { avatarUrl: next.url, avatarFileId: fileId } });
    if (oldId && oldId !== fileId) await imagekit.deleteFile(oldId);
    res.json({ avatarUrl: next.url });
  });

  app.put('/admin/payment-qr', ...userGuard, superAdmin, async (req, res) => {
    const parsed = z.object({ method: z.enum(['bkash', 'nagad']) }).and(saveInput).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid' });
    const { method, url } = parsed.data;
    if (url && !imagekit.isOurFile(url, '/payment-qr')) return res.status(400).json({ error: 'not_our_file' });
    const s = await deps.settings();
    const oldId = s.paymentQrFileIds[method];
    const fileId = 'fileId' in parsed.data ? parsed.data.fileId : '';
    await Settings.updateOne(
      { _id: 'global' },
      { $set: { [`paymentQr.${method}`]: url, [`paymentQrFileIds.${method}`]: fileId } },
      { upsert: true },
    );
    if (oldId && oldId !== fileId) await imagekit.deleteFile(oldId);
    res.json({ paymentQr: { ...s.paymentQr, [method]: url } });
  });
}
