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
import { searchRegex } from '../lib/search.js';
import type { Telegram } from '../lib/telegram.js';
import { SubscriptionLog } from '../models/SubscriptionLog.js';
import { User, type UserDoc } from '../models/User.js';

const DAY = 86_400_000;
const PAGE = 30;


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
    ownerName: (u as unknown as { ownerName?: string }).ownerName ?? '',
    signInProvider: (u as unknown as { signInProvider?: string }).signInProvider ?? '',
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

/**
 * Extend a subscription by `days`, ON TOP of the remaining time (nobody loses paid days), and log it.
 * Shared by the manual admin action and payment approval.
 */
export async function extendSubscription(
  u: UserDoc,
  days: number,
  plan: string,
  by: string,
  extra: { amount?: number; method?: string; trxId?: string; note?: string } = {},
): Promise<Date> {
  const before = u.subscription.expiresAt;
  const after = new Date(Math.max(Date.now(), before.getTime()) + days * DAY);
  await User.updateOne({ _id: u._id }, { $set: { 'subscription.expiresAt': after, 'subscription.status': 'active', 'subscription.plan': plan } });
  await SubscriptionLog.create({ userId: u._id, accountId: u.accountId, action: 'extend', plan, days, before, after, ...extra, by });
  return after;
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
  deps: { telegram: Telegram; chatIds: () => Promise<string[]>; adminUrl: string },
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
    // charts: new users per day (30 days) and money per month (6 months, from the subscription log,
    // so approved requests AND manual extensions with an amount both count)
    const since30 = new Date(Date.now() - 29 * DAY);
    since30.setHours(0, 0, 0, 0);
    const since6m = new Date();
    since6m.setMonth(since6m.getMonth() - 5, 1);
    since6m.setHours(0, 0, 0, 0);
    const tz = 'Asia/Dhaka';
    const [signups, revenue] = await Promise.all([
      User.aggregate([
        { $match: { createdAt: { $gte: since30 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, n: { $sum: 1 } } },
      ]),
      SubscriptionLog.aggregate([
        { $match: { createdAt: { $gte: since6m }, amount: { $gt: 0 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: tz } }, taka: { $sum: '$amount' }, n: { $sum: 1 } } },
      ]),
    ]);
    const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); // yyyy-mm-dd
    const byDay = new Map(signups.map((x: { _id: string; n: number }) => [x._id, x.n]));
    const signupsByDay = Array.from({ length: 30 }, (_, i) => {
      const k = dayKey(new Date(since30.getTime() + i * DAY));
      return { day: k, users: byDay.get(k) ?? 0 };
    });
    const byMonth = new Map(revenue.map((x: { _id: string; taka: number; n: number }) => [x._id, x]));
    const revenueByMonth = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(since6m);
      d.setMonth(since6m.getMonth() + i);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const m = byMonth.get(k) as { taka: number; n: number } | undefined;
      return { month: k, taka: m?.taka ?? 0, orders: m?.n ?? 0 };
    });
    res.json({ total, trial, paid, expired, blocked, endingSoon: (endingSoon as UserDoc[]).map(row), signupsByDay, revenueByMonth });
  });

  app.get('/admin/users', ...guard, async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const filter = String(req.query.filter ?? 'all');
    const page = Math.max(1, Number(req.query.page) || 1);
    const now = new Date();
    const where: Record<string, unknown> = {};
    if (q) {
      const rx = searchRegex(q); // English or Bangla digits both match
      where.$or = [{ accountId: rx }, { email: rx }, { phone: rx }, { shopName: rx }, { ownerName: rx }, { displayName: rx }, { referralCode: rx }];
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
    const adminEmail = (req as unknown as { user: UserDoc }).user.email;
    const a = action.data;
    if (a.action === 'extend') {
      const after = await extendSubscription(u, a.days, a.plan, adminEmail, pay.data);
      const taka = pay.data.amount ? ` · ৳${pay.data.amount}${pay.data.method ? ` (${pay.data.method})` : ''}` : '';
      const link = deps.adminUrl ? `\n${deps.adminUrl}/users/${u.accountId}` : '';
      await deps.telegram.notify(`✅ সাবস্ক্রিপশন: ${u.accountId} → ${after.toISOString().slice(0, 10)} পর্যন্ত${taka}${link}`, await deps.chatIds());
      return res.json({ user: row((await User.findById(u._id)) as UserDoc) });
    }
    let after: Date;
    let plan = u.subscription.plan;
    let status: 'trial' | 'active' | 'expired' = 'active';
    if (a.action === 'set_date') {
      after = new Date(a.expiresAt);
      after.setHours(23, 59, 59, 999);
      plan = a.plan;
    } else {
      after = new Date(Date.now() - 1000);
      status = 'expired';
    }

    await User.updateOne({ _id: u._id }, { $set: { 'subscription.expiresAt': after, 'subscription.status': status, 'subscription.plan': plan } });
    await SubscriptionLog.create({ userId: u._id, accountId: u.accountId, action: a.action, plan, days: 0, before, after, ...pay.data, by: adminEmail });
    const updated = (await User.findById(u._id)) as UserDoc;
    res.json({ user: row(updated) });
  });

  /** Referral role: promoter (cash commission) or regular (free months). */
  app.post('/admin/users/:accountId/referrer-type', ...guard, async (req, res) => {
    const parsed = z.object({ referrerType: z.enum(['regular', 'promoter']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid' });
    const u = (await User.findOneAndUpdate({ accountId: req.params.accountId }, { $set: { referrerType: parsed.data.referrerType } }, { new: true })) as UserDoc | null;
    if (!u) return res.status(404).json({ error: 'not_found' });
    res.json({ user: row(u) });
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
