/**
 * Express app. Dependencies (token verifier, Telegram) are passed in so tests can run without
 * Firebase or the network.
 *
 * Routes (contract: jomarKhata-fe/docs/BACKEND_CONTRACT.md):
 *   GET  /health
 *   GET  /config                public values the app caches (WhatsApp, trial days, referral rate …)
 *   POST /auth/session          after Firebase sign-in: create the account on first login, return it
 *   GET  /me                    the signed-in user's account
 *   POST /me/referral           add a referral code ONCE (no referrer yet, within 7 days of sign-up)
 *   GET  /subscription          { status, expiresAt, serverTime }
 *   GET  /admin/me              super admin only (the /admin panel checks this)
 *   GET  /admin/settings        super admin: changeable values
 *   PUT  /admin/settings        super admin: update them (no env / code change needed)
 */
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { list, type Config } from './config.js';
import { newAccountId, newReferralCode, normalizeReferralCode } from './lib/ids.js';
import type { Telegram } from './lib/telegram.js';
import { getSettings, Settings, type SettingsValue } from './models/Settings.js';
import { canAddReferral, publicUser, User, type UserDoc } from './models/User.js';

/** Result of verifying a Firebase ID token (firebase-admin in production, a fake in tests). */
export interface VerifiedToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  phone_number?: string;
}
export type VerifyToken = (idToken: string) => Promise<VerifiedToken>;

interface Deps {
  config: Config;
  verifyToken: VerifyToken;
  telegram: Telegram;
}

type AuthedRequest = Request & { token?: VerifiedToken; user?: UserDoc };

/** Retry an insert when a random unique value collides (MongoDB duplicate key 11000). */
async function withUniqueRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const dup = (err as { code?: number }).code === 11000;
      const onUid = JSON.stringify((err as { keyPattern?: unknown }).keyPattern ?? {}).includes('firebaseUid');
      if (!dup || onUid || i >= tries - 1) throw err;
    }
  }
}

const TELEGRAM_CHAT_ID = /^-?\d{3,20}$/;
const settingsInput = z
  .object({
    supportWhatsApp: z.string().trim().max(20),
    trialDays: z.number().int().min(0).max(365),
    referralRate: z.number().min(0).max(1),
    paymentNumbers: z.object({ bkash: z.string().max(40), nagad: z.string().max(40), bank: z.string().max(200) }).partial(),
    telegramChatIds: z.array(z.string().trim().regex(TELEGRAM_CHAT_ID, 'Telegram chat ID সংখ্যা হতে হবে')).max(10),
  })
  .partial();

export function createApp({ config, verifyToken, telegram }: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: list(config.CORS_ORIGINS), credentials: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

  const superAdmins = new Set(list(config.SUPER_ADMIN_EMAILS).map((e) => e.toLowerCase()));
  // env values only seed the settings until the owner edits them in the dashboard
  const settings = () => getSettings({ trialDays: config.TRIAL_DAYS, telegramChatIds: list(config.TELEGRAM_ADMIN_CHAT_ID) });

  /** Verifies "Authorization: Bearer <Firebase ID token>". */
  const requireToken = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!idToken) return res.status(401).json({ error: 'unauthenticated', message: 'লগইন করুন।' });
    try {
      req.token = await verifyToken(idToken);
      next();
    } catch {
      res.status(401).json({ error: 'invalid_token', message: 'লগইনের মেয়াদ শেষ। আবার লগইন করুন।' });
    }
  };

  /** Token + an existing, non-blocked account. */
  const requireUser = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const user = (await User.findOne({ firebaseUid: req.token!.uid })) as UserDoc | null;
    if (!user) return res.status(404).json({ error: 'no_account', message: 'অ্যাকাউন্ট পাওয়া যায়নি। আবার লগইন করুন।' });
    if (user.status === 'blocked') return res.status(403).json({ error: 'blocked', message: 'এই অ্যাকাউন্ট বন্ধ আছে। সাহায্যের জন্য যোগাযোগ করুন।' });
    req.user = user;
    next();
  };

  const requireSuperAdmin = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.user!.role !== 'super_admin') return res.status(403).json({ error: 'forbidden' });
    next();
  };

  const referredCount = (u: UserDoc) => User.countDocuments({ referredBy: u._id });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, serverTime: new Date().toISOString() });
  });

  /** Public values the app and landing page show (the app caches them for offline use). */
  app.get('/config', async (_req, res) => {
    const s = await settings();
    res.set('cache-control', 'public, max-age=300');
    res.json({ supportWhatsApp: s.supportWhatsApp, trialDays: s.trialDays, referral: { rate: s.referralRate }, paymentNumbers: s.paymentNumbers });
  });

  app.post('/auth/session', requireToken, async (req: AuthedRequest, res) => {
    const t = req.token!;
    let user = (await User.findOne({ firebaseUid: t.uid })) as UserDoc | null;
    let created = false;
    let referralAccepted: boolean | null = null;

    if (!user) {
      // Accounts are email-based (owner rule): no email → no account.
      if (!t.email) return res.status(400).json({ error: 'email_required', message: 'অ্যাকাউন্ট খুলতে ইমেইল লাগবে।' });

      let referredBy = null;
      const code = normalizeReferralCode((req.body as { referralCode?: unknown } | undefined)?.referralCode);
      if (code) {
        const ref = (await User.findOne({ referralCode: code })) as UserDoc | null;
        referralAccepted = Boolean(ref && ref.email !== t.email.toLowerCase());
        if (referralAccepted) referredBy = ref!._id;
      }

      const email = t.email.toLowerCase();
      const s = await settings();
      user = (await withUniqueRetry(() =>
        User.create({
          firebaseUid: t.uid,
          accountId: newAccountId(),
          referralCode: newReferralCode(),
          email,
          emailVerified: Boolean(t.email_verified),
          displayName: t.name ?? '',
          phone: t.phone_number ?? '',
          role: superAdmins.has(email) ? 'super_admin' : 'user',
          referredBy,
          subscription: { status: 'trial', plan: 'trial', expiresAt: new Date(Date.now() + s.trialDays * 86_400_000) },
        }),
      )) as unknown as UserDoc;
      created = true;
      const link = config.ADMIN_URL ? `\n${config.ADMIN_URL}/users/${user.accountId}` : '';
      await telegram.notify(`🆕 নতুন অ্যাকাউন্ট: ${user.accountId}\n${email}${referredBy ? `\nরেফারেল: ${code}` : ''}${link}`, s.telegramChatIds);
    } else {
      if (user.status === 'blocked') return res.status(403).json({ error: 'blocked', message: 'এই অ্যাকাউন্ট বন্ধ আছে।' });
      user.lastSeenAt = new Date();
      if (t.email_verified) user.emailVerified = true;
      if (superAdmins.has(user.email) && user.role !== 'super_admin') user.role = 'super_admin';
      await (user as unknown as { save(): Promise<unknown> }).save();
    }

    res.status(created ? 201 : 200).json({
      created,
      referralAccepted,
      user: publicUser(user, { referredUsers: await referredCount(user) }),
      serverTime: new Date().toISOString(),
    });
  });

  app.get('/me', requireToken, requireUser, async (req: AuthedRequest, res) => {
    res.json({ user: publicUser(req.user!, { referredUsers: await referredCount(req.user!) }), serverTime: new Date().toISOString() });
  });

  /** One-time: link a referrer after sign-up (e.g. someone who signed in with Google and skipped it). */
  app.post('/me/referral', requireToken, requireUser, async (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.referredBy) return res.status(409).json({ error: 'already_set', message: 'রেফারেল কোড আগেই যোগ করা হয়েছে।' });
    if (!canAddReferral(user)) return res.status(410).json({ error: 'too_late', message: 'রেফারেল কোড শুধু অ্যাকাউন্ট খোলার প্রথম ৭ দিনে দেওয়া যায়।' });
    const code = normalizeReferralCode((req.body as { referralCode?: unknown } | undefined)?.referralCode);
    if (!code) return res.status(400).json({ error: 'invalid_code', message: 'রেফারেল কোডটি ঠিক নেই।' });
    const ref = (await User.findOne({ referralCode: code })) as UserDoc | null;
    if (!ref) return res.status(404).json({ error: 'unknown_code', message: 'এই রেফারেল কোড পাওয়া যায়নি।' });
    if (String(ref._id) === String(user._id)) return res.status(400).json({ error: 'own_code', message: 'নিজের কোড দেওয়া যাবে না।' });
    // set once, atomically (a second request can't overwrite it)
    const updated = (await User.findOneAndUpdate({ _id: user._id, referredBy: null }, { $set: { referredBy: ref._id } }, { new: true })) as UserDoc | null;
    if (!updated) return res.status(409).json({ error: 'already_set', message: 'রেফারেল কোড আগেই যোগ করা হয়েছে।' });
    const s = await settings();
    await telegram.notify(`🎁 রেফারেল যোগ হলো: ${updated.accountId} ← ${code} (${ref.accountId})`, s.telegramChatIds);
    res.json({ user: publicUser(updated, { referredUsers: await referredCount(updated) }), serverTime: new Date().toISOString() });
  });

  app.get('/subscription', requireToken, requireUser, (req: AuthedRequest, res) => {
    const s = req.user!.subscription;
    const expired = s.expiresAt.getTime() < Date.now();
    res.json({ status: expired ? 'expired' : s.status, expiresAt: s.expiresAt.toISOString(), serverTime: new Date().toISOString() });
  });

  app.get('/admin/me', requireToken, requireUser, requireSuperAdmin, (req: AuthedRequest, res) => {
    res.json({ role: 'super_admin', email: req.user!.email });
  });

  app.get('/admin/settings', requireToken, requireUser, requireSuperAdmin, async (_req, res) => {
    res.json({ settings: await settings(), telegramBotConfigured: telegram.enabled });
  });

  app.put('/admin/settings', requireToken, requireUser, requireSuperAdmin, async (req: AuthedRequest, res) => {
    const parsed = settingsInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'তথ্য ঠিক নেই।' });
    const current = await settings();
    const next: SettingsValue = {
      ...current,
      ...parsed.data,
      paymentNumbers: { ...current.paymentNumbers, ...(parsed.data.paymentNumbers ?? {}) },
    };
    await Settings.updateOne({ _id: 'global' }, { $set: { ...next, updatedBy: req.user!.email } }, { upsert: true });
    res.json({ settings: next });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'server_error', message: 'সার্ভারে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।' });
  });

  return app;
}
