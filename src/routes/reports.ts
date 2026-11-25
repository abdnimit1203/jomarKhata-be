/**
 * Bug reports ("সমস্যা জানান").
 *   App (signed in OR guest):
 *     POST /reports                 { message, page?, appVersion? } → saved (+ Telegram). 403 when the
 *                                   owner has turned the button off in settings.
 *   Super admin:
 *     GET  /admin/reports?status=open|resolved|all&q=&page=
 *     POST /admin/reports/:id/status { status: 'open' | 'resolved' }
 */
import type { Express, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { searchRegex } from '../lib/search.js';
import { contactRow, type Telegram } from '../lib/telegram.js';
import { BugReport } from '../models/BugReport.js';
import type { SettingsValue } from '../models/Settings.js';
import type { UserDoc } from '../models/User.js';

const PAGE = 30;

const reportInput = z.object({
  message: z.string().trim().min(3, 'সমস্যাটা একটু লিখুন').max(1000, 'একটু ছোট করে লিখুন'),
  page: z.string().trim().max(120).default(''),
  appVersion: z.string().trim().max(40).default(''),
});

type Req = { user?: UserDoc; params: Record<string, string>; body: unknown; query: Record<string, unknown> };

export function registerReportRoutes(
  app: Express,
  optionalUser: RequestHandler,
  adminGuard: RequestHandler[],
  deps: { telegram: Telegram; settings: () => Promise<SettingsValue>; adminUrl: string },
) {
  // a few reports per device per 10 minutes is plenty; stops a stuck button or spam
  const limiter = rateLimit({ windowMs: 10 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });

  app.post('/reports', limiter, optionalUser, async (req, res) => {
    const { user } = req as unknown as Req;
    const s = await deps.settings();
    if (!s.bugReportEnabled) return res.status(403).json({ error: 'disabled', message: 'এখন রিপোর্ট নেওয়া বন্ধ আছে।' });
    const parsed = reportInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'তথ্য ঠিক নেই।' });
    const doc = await BugReport.create({
      userId: user?._id ?? null,
      accountId: user?.accountId ?? '',
      email: user?.email ?? '',
      shopName: user?.shopName ?? '',
      ...parsed.data,
      userAgent: (req.get('user-agent') ?? '').slice(0, 300),
    });
    await deps.telegram.notify(
      {
        title: '🐞 NEW ISSUE REPORT',
        rows: user
          ? [['Name', user.shopName || user.displayName || '—'], ['User ID', user.accountId], contactRow(user), ['Page', parsed.data.page], ['App', parsed.data.appVersion]]
          : [['From', 'Guest (not signed in)'], ['Page', parsed.data.page], ['App', parsed.data.appVersion]],
        body: parsed.data.message.slice(0, 500),
        button: deps.adminUrl ? { text: 'View report', url: `${deps.adminUrl}/reports` } : undefined,
      },
      s.telegramChatIds,
    );
    res.status(201).json({ ok: true, id: doc._id });
  });

  app.get('/admin/reports', ...adminGuard, async (req, res) => {
    const status = String(req.query.status ?? 'open');
    const q = String(req.query.q ?? '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const where: Record<string, unknown> = {};
    if (status !== 'all') where.status = status;
    if (q) {
      const rx = searchRegex(q);
      where.$or = [{ accountId: rx }, { email: rx }, { shopName: rx }, { message: rx }, { page: rx }];
    }
    const [total, list, open] = await Promise.all([
      BugReport.countDocuments(where),
      BugReport.find(where).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean(),
      BugReport.countDocuments({ status: 'open' }),
    ]);
    res.json({ total, page, pageSize: PAGE, open, reports: list });
  });

  app.post('/admin/reports/:id/status', ...adminGuard, async (req, res) => {
    const { user: admin, params } = req as unknown as Req;
    const body = z.object({ status: z.enum(['open', 'resolved']) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid' });
    if (!mongoose.isValidObjectId(params.id)) return res.status(404).json({ error: 'not_found' });
    const resolved = body.data.status === 'resolved';
    const doc = await BugReport.findByIdAndUpdate(
      params.id,
      { $set: { status: body.data.status, resolvedBy: resolved ? admin!.email : '', resolvedAt: resolved ? new Date() : null } },
      { returnDocument: 'after' },
    );
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json({ report: doc });
  });
}
