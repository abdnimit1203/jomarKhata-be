/**
 * Subscription payments.
 *   User (signed in):
 *     POST /me/payments            { plan, method, trxId, payerNumber?, note? } → pending request (+ Telegram)
 *     GET  /me/payments            own requests (latest first)
 *   Super admin:
 *     GET  /admin/payments?status=pending|approved|rejected|all&q=&page=
 *     POST /admin/payments/:id/approve   → subscription extended by the plan's days (logged)
 *     POST /admin/payments/:id/reject    { reason }
 * "Orders" = approved requests. Plans and prices come from settings (admin-editable).
 */
import type { Express, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import type { Telegram } from '../lib/telegram.js';
import { PaymentRequest } from '../models/PaymentRequest.js';
import type { SettingsValue } from '../models/Settings.js';
import { User, type UserDoc } from '../models/User.js';
import { extendSubscription } from './admin.js';

const PAGE = 30;
const METHOD_BN: Record<string, string> = { bkash: 'বিকাশ', nagad: 'নগদ', bank: 'ব্যাংক' };
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const requestInput = z.object({
  plan: z.string().trim().min(1).max(20),
  method: z.enum(['bkash', 'nagad', 'bank']),
  trxId: z.string().trim().min(4, 'TrxID ঠিকভাবে লিখুন').max(40),
  payerNumber: z.string().trim().max(20).default(''),
  note: z.string().trim().max(200).default(''),
});

type Req = { user: UserDoc; params: Record<string, string>; body: unknown; query: Record<string, unknown> };

export function registerPaymentRoutes(
  app: Express,
  userGuard: RequestHandler[],
  adminGuard: RequestHandler[],
  deps: { telegram: Telegram; settings: () => Promise<SettingsValue>; adminUrl: string },
) {
  app.post('/me/payments', ...userGuard, async (req, res) => {
    const { user } = req as unknown as Req;
    const parsed = requestInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'তথ্য ঠিক নেই।' });
    const s = await deps.settings();
    const plan = s.plans.find((p) => p.key === parsed.data.plan);
    if (!plan) return res.status(400).json({ error: 'unknown_plan', message: 'এই প্ল্যান পাওয়া যায়নি।' });
    const pendingCount = await PaymentRequest.countDocuments({ userId: user._id, status: 'pending' });
    if (pendingCount >= 3) return res.status(429).json({ error: 'too_many', message: 'আগের রিকোয়েস্টগুলো দেখা হচ্ছে। একটু অপেক্ষা করুন।' });
    try {
      const doc = await PaymentRequest.create({
        userId: user._id,
        accountId: user.accountId,
        email: user.email,
        shopName: user.shopName,
        method: parsed.data.method,
        payerNumber: parsed.data.payerNumber,
        note: parsed.data.note,
        trxId: parsed.data.trxId.toUpperCase(),
        // plan details come from the server's settings, never from the client
        plan: plan.key,
        planLabel: plan.label,
        days: plan.days,
        amount: plan.price,
      });
      const link = deps.adminUrl ? `\n${deps.adminUrl}/payments` : '';
      await deps.telegram.notify(
        `💰 নতুন পেমেন্ট রিকোয়েস্ট: ${plan.label} · ৳${plan.price} · ${METHOD_BN[parsed.data.method]}\nTrxID: ${doc.trxId}\n${user.accountId} · ${user.email}${link}`,
        s.telegramChatIds,
      );
      res.status(201).json({ request: doc });
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        return res.status(409).json({ error: 'duplicate_trx', message: 'এই TrxID আগেই জমা দেওয়া হয়েছে।' });
      throw err;
    }
  });

  app.get('/me/payments', ...userGuard, async (req, res) => {
    const { user } = req as unknown as Req;
    const list = await PaymentRequest.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ requests: list });
  });

  app.get('/admin/payments', ...adminGuard, async (req, res) => {
    const status = String(req.query.status ?? 'pending');
    const q = String(req.query.q ?? '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const where: Record<string, unknown> = {};
    if (status !== 'all') where.status = status;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      where.$or = [{ accountId: rx }, { email: rx }, { trxId: rx }, { shopName: rx }, { payerNumber: rx }];
    }
    const [total, list, pending] = await Promise.all([
      PaymentRequest.countDocuments(where),
      PaymentRequest.find(where).sort({ createdAt: status === 'pending' ? 1 : -1 }).skip((page - 1) * PAGE).limit(PAGE).lean(),
      PaymentRequest.countDocuments({ status: 'pending' }),
    ]);
    res.json({ total, page, pageSize: PAGE, pending, requests: list });
  });

  app.post('/admin/payments/:id/approve', ...adminGuard, async (req, res) => {
    const { user: admin, params } = req as unknown as Req;
    if (!mongoose.isValidObjectId(params.id)) return res.status(404).json({ error: 'not_found' });
    // claim it atomically so a double click can't extend twice
    const pr = await PaymentRequest.findOneAndUpdate(
      { _id: params.id, status: 'pending' },
      { $set: { status: 'approved', decidedBy: admin.email, decidedAt: new Date() } },
      { new: true },
    );
    if (!pr) return res.status(409).json({ error: 'not_pending', message: 'এই রিকোয়েস্ট আগেই দেখা হয়েছে।' });
    const u = (await User.findById(pr.userId)) as UserDoc | null;
    if (!u) return res.status(404).json({ error: 'no_user' });
    const after = await extendSubscription(u, pr.days, pr.plan, admin.email, { amount: pr.amount, method: pr.method, trxId: pr.trxId, note: `payment ${pr._id}` });
    pr.expiresAtAfter = after;
    await pr.save();
    res.json({ request: pr });
  });

  app.post('/admin/payments/:id/reject', ...adminGuard, async (req, res) => {
    const { user: admin, params } = req as unknown as Req;
    const reason = z.object({ reason: z.string().trim().min(1, 'কারণ লিখুন').max(200) }).safeParse(req.body);
    if (!reason.success) return res.status(400).json({ error: 'invalid', message: 'কারণ লিখুন।' });
    if (!mongoose.isValidObjectId(params.id)) return res.status(404).json({ error: 'not_found' });
    const pr = await PaymentRequest.findOneAndUpdate(
      { _id: params.id, status: 'pending' },
      { $set: { status: 'rejected', decidedBy: admin.email, decidedAt: new Date(), reason: reason.data.reason } },
      { new: true },
    );
    if (!pr) return res.status(409).json({ error: 'not_pending', message: 'এই রিকোয়েস্ট আগেই দেখা হয়েছে।' });
    res.json({ request: pr });
  });
}
