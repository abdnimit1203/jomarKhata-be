/**
 * Super-admin routes (all behind requireToken → requireUser → requireSuperAdmin):
 *   GET  /admin/stats                         counts + subscriptions ending within 7 days
 *   GET  /admin/users?q=&page=                search by account ID, email, phone, shop, referral code
 *   GET  /admin/users/:accountId              one user + referrals + subscription history
 *   POST /admin/users/:accountId/subscription extend by days / set an end date / expire now (logged)
 *   POST /admin/users/:accountId/status       { status: 'active' | 'blocked' }
 */
import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { Telegram } from '../lib/telegram.js';
import { SubscriptionLog } from '../models/SubscriptionLog.js';
import { User, type UserDoc } from '../models/User.js';

const DAY = 86_400_000;
const PAGE = 30;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Effective status right now (an expired date wins over the stored status). */
export function subscriptionStatus(u: { subscription: { status: string; expiresAt: Date } }): 'trial' | 'active' | 'expired' {
  return u.subscription.expiresAt.getTime() < Date.now() ? 'expired' : (u.subscription.status as 'trial' | 'active');
}

function row(u: UserDoc) {
  const left = Math.ceil((u.subscription.expiresAt.getTime() - Date.now()) / DAY);
  return {
    accountId: u.accountId,
    email: u.email,
    phone: u.phone,
    shopName: u.shopName,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    referralCode: u.referralCode,
    referrerType: u.referrerType,
    createdAt: (u as unknown as { createdAt: Date }).createdAt,
    lastSeenAt: u.lastSeenAt,
    subscription: { status: subscriptionStatus(u), plan: u.subscription.plan, expiresAt: u.subscription.expiresAt, daysLeft: left },
  };
}

const subscriptionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('extend'), days: z.number().int().min(1).max(3650), plan: z.string().max(40).default('paid') }),
  z.object({ action: z.literal('set_date'), expiresAt: z.coerce.date(), plan: z.string().max(40).default('paid') }),
  z.object({ action: z.literal('expire') }),
]);
const paymentInput = z.object({
  amount: z.number().min(0).max(1_000_000).default(0),
  method: z.string().max(20).default(''),
  trxId: z.string().max(60).default(''),
  note: z.string().max(300).default(''),
});

export function registerAdminRoutes(
  app: Express,
  guard: RequestHandler[],
  deps: { telegram: Telegram; chatIds: () => Promise<string[]> },
) {
  app.get('/admin/stats', ...guard, async (_req, res) => {
    const now = new Date();
    const soon = new Date(Date.now() + 7 * DAY);
    const [total, trial, paid, expired, blocked, endingSoon] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ 'subscription.status': 'trial', 'subscription.expiresAt': { $gte: now } }),
      User.countDocuments({ 'subscription.status': 'active', 'subscription.expiresAt': { $gte: now } }),
      User.countDocuments({ 'subscription.expiresAt': { $lt: now } }),
      User.countDocuments({ status: 'blocked' }),
      User.find({ 'subscription.expiresAt': { $gte: now, $lte: soon } }).sort({ 'subscription.expiresAt': 1 }).limit(50),
    ]);
    res.json({ total, trial, paid, expired, blocked, endingSoon: (endingSoon as UserDoc[]).map(row) });
  });

  app.get('/admin/users', ...guard, async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const filter = String(req.query.filter ?? 'all');
    const page = Math.max(1, Number(req.query.page) || 1);
    const now = new Date();
    const where: Record<string, unknown> = {};
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      where.$or = [{ accountId: rx }, { email: rx }, { phone: rx }, { shopName: rx }, { displayName: rx }, { referralCode: rx }];
    }
    if (filter === 'trial') Object.assign(where, { 'subscription.status': 'trial', 'subscription.expiresAt': { $gte: now } });
    if (filter === 'paid') Object.assign(where, { 'subscription.status': 'active', 'subscription.expiresAt': { $gte: now } });
    if (filter === 'expired') Object.assign(where, { 'subscription.expiresAt': { $lt: now } });
    if (filter === 'blocked') Object.assign(where, { status: 'blocked' });
    const [total, users] = await Promise.all([
      User.countDocuments(where),
      User.find(where).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE),
    ]);
    res.json({ total, page, pageSize: PAGE, users: (users as UserDoc[]).map(row) });
  });

  app.get('/admin/users/:accountId', ...guard, async (req, res) => {
    const u = (await User.findOne({ accountId: req.params.accountId })) as UserDoc | null;
    if (!u) return res.status(404).json({ error: 'not_found', message: 'ইউজার পাওয়া যায়নি।' });
    const [referrer, referred, history] = await Promise.all([
      u.referredBy ? User.findById(u.referredBy) : null,
      User.find({ referredBy: u._id }).sort({ createdAt: -1 }).limit(200),
      SubscriptionLog.find({ userId: u._id }).sort({ createdAt: -1 }).limit(100).lean(),
    ]);
    res.json({
      user: row(u),
      referredBy: referrer ? { accountId: (referrer as UserDoc).accountId, email: (referrer as UserDoc).email, referralCode: (referrer as UserDoc).referralCode } : null,
      referred: (referred as UserDoc[]).map(row),
      history,
    });
  });

  app.post('/admin/users/:accountId/subscription', ...guard, async (req, res) => {
    const action = subscriptionInput.safeParse(req.body);
    const pay = paymentInput.safeParse(req.body ?? {});
    if (!action.success || !pay.success) return res.status(400).json({ error: 'invalid', message: 'তথ্য ঠিক নেই।' });
    const u = (await User.findOne({ accountId: req.params.accountId })) as UserDoc | null;
    if (!u) return res.status(404).json({ error: 'not_found', message: 'ইউজার পাওয়া যায়নি।' });

    const before = u.subscription.expiresAt;
    let after: Date;
    let plan = u.subscription.plan;
    let status: 'trial' | 'active' | 'expired' = 'active';
    const a = action.data;
    if (a.action === 'extend') {
      // add on top of the remaining time, so nobody loses paid days
      const base = Math.max(Date.now(), before.getTime());
      after = new Date(base + a.days * DAY);
      plan = a.plan;
    } else if (a.action === 'set_date') {
      after = new Date(a.expiresAt);
      after.setHours(23, 59, 59, 999);
      plan = a.plan;
    } else {
      after = new Date(Date.now() - 1000);
      status = 'expired';
    }

    await User.updateOne({ _id: u._id }, { $set: { 'subscription.expiresAt': after, 'subscription.status': status, 'subscription.plan': plan } });
    const adminEmail = (req as unknown as { user: UserDoc }).user.email;
    await SubscriptionLog.create({
      userId: u._id,
      accountId: u.accountId,
      action: a.action,
      plan,
      days: a.action === 'extend' ? a.days : 0,
      before,
      after,
      ...pay.data,
      by: adminEmail,
    });
    if (a.action !== 'expire') {
      const taka = pay.data.amount ? ` · ৳${pay.data.amount}${pay.data.method ? ` (${pay.data.method})` : ''}` : '';
      await deps.telegram.notify(
        `✅ সাবস্ক্রিপশন: ${u.accountId} → ${after.toISOString().slice(0, 10)} পর্যন্ত${taka}`,
        await deps.chatIds(),
      );
    }
    const updated = (await User.findById(u._id)) as UserDoc;
    res.json({ user: row(updated) });
  });

  app.post('/admin/users/:accountId/status', ...guard, async (req, res) => {
    const parsed = z.object({ status: z.enum(['active', 'blocked']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid' });
    const u = (await User.findOne({ accountId: req.params.accountId })) as UserDoc | null;
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.role === 'super_admin') return res.status(400).json({ error: 'protected', message: 'সুপার অ্যাডমিনকে বন্ধ করা যায় না।' });
    await User.updateOne({ _id: u._id }, { $set: { status: parsed.data.status } });
    res.json({ user: row((await User.findById(u._id)) as UserDoc) });
  });
}
