/**
 * API tests against an in-memory MongoDB and a fake Firebase token verifier (no network).
 * Token format in tests: "uid|email" (verified), "bad" → rejected.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type VerifyToken } from '../src/createApp.js';
import { loadConfig } from '../src/config.js';
import { newAccountId, newReferralCode, normalizeReferralCode } from '../src/lib/ids.js';
import { User } from '../src/models/User.js';
import { renderAlert, type Alert } from '../src/lib/telegram.js';

let mongo: MongoMemoryServer;
const sent: string[] = [];
const verifyToken: VerifyToken = async (t) => {
  if (t === 'bad') throw new Error('invalid');
  const [uid, email, provider] = t.split('|');
  return { uid, email: email || undefined, email_verified: true, firebase: { sign_in_provider: provider || 'password' } };
};
const config = loadConfig({
  MONGODB_URI: 'unused',
  FIREBASE_PROJECT_ID: 'x',
  FIREBASE_CLIENT_EMAIL: 'x',
  FIREBASE_PRIVATE_KEY: 'x',
  SUPER_ADMIN_EMAILS: 'owner@example.com',
  TRIAL_DAYS: '30',
  TELEGRAM_ADMIN_CHAT_ID: '12345',
} as NodeJS.ProcessEnv);
const app = createApp({ config, verifyToken, telegram: { enabled: true, notify: async (a: Alert) => void sent.push(renderAlert(a).text) } });
const login = (token: string, body: object = {}) => request(app).post('/auth/session').set('authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await User.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
  sent.length = 0;
});

describe('ids', () => {
  it('account ID and referral code formats; referral normalisation', () => {
    expect(newAccountId()).toMatch(/^JK-\d{4}-\d{4}$/);
    for (let i = 0; i < 2000; i++) expect(newAccountId().startsWith('JK-0')).toBe(false); // JK-0000-… is reserved for staff
    expect(newReferralCode()).toMatch(/^JK[A-HJ-NP-Z2-9]{6}$/);
    expect(normalizeReferralCode(' jk7q-4m2x ')).toBe('JK7Q4M2X');
    expect(normalizeReferralCode('x!')).toBeNull();
  });
});

describe('auth', () => {
  it('rejects missing and invalid tokens', async () => {
    expect((await request(app).get('/me')).status).toBe(401);
    expect((await request(app).get('/me').set('authorization', 'Bearer bad')).status).toBe(401);
  });

  it('first login creates the account: unique IDs, 30-day trial, Telegram alert; second login reuses it', async () => {
    const r1 = await login('u1|shop@example.com');
    expect(r1.status).toBe(201);
    expect(r1.body.created).toBe(true);
    expect(r1.body.user.accountId).toMatch(/^JK-\d{4}-\d{4}$/);
    expect(r1.body.user.referralCode).toMatch(/^JK/);
    const days = (Date.parse(r1.body.user.subscription.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(sent[0]).toContain('NEW USER');
    expect(sent[0]).toContain(r1.body.user.accountId);

    const r2 = await login('u1|shop@example.com');
    expect(r2.status).toBe(200);
    expect(r2.body.user.accountId).toBe(r1.body.user.accountId);
    expect(await User.countDocuments()).toBe(1);
  });

  it('no email → no account', async () => {
    const r = await login('u2|');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('email_required');
  });

  it('referral: a valid code links the new user; unknown code is ignored; counts show on /me', async () => {
    const a = await login('ua|a@example.com');
    const b = await login('ub|b@example.com', { referralCode: a.body.user.referralCode.toLowerCase() });
    expect(b.body.referralAccepted).toBe(true);
    const c = await login('uc|c@example.com', { referralCode: 'JKZZZZZZ' });
    expect(c.status).toBe(201);
    expect(c.body.referralAccepted).toBe(false);
    const me = await request(app).get('/me').set('authorization', 'Bearer ua|a@example.com');
    expect(me.body.user.referralStats.referredUsers).toBe(1);
  });

  it('super admin by email; others get 403 on /admin/me; blocked users are refused', async () => {
    await login('own|owner@example.com');
    expect((await request(app).get('/admin/me').set('authorization', 'Bearer own|owner@example.com')).status).toBe(200);
    await login('u9|user@example.com');
    expect((await request(app).get('/admin/me').set('authorization', 'Bearer u9|user@example.com')).status).toBe(403);
    await User.updateOne({ firebaseUid: 'u9' }, { status: 'blocked' });
    expect((await request(app).get('/me').set('authorization', 'Bearer u9|user@example.com')).status).toBe(403);
  });

  it('/subscription returns status, expiry and server time', async () => {
    await login('u5|s@example.com');
    const r = await request(app).get('/subscription').set('authorization', 'Bearer u5|s@example.com');
    expect(r.body.status).toBe('trial');
    expect(typeof r.body.serverTime).toBe('string');
  });
});

describe('settings (changeable from the dashboard, not env)', () => {
  beforeEach(async () => {
    await mongoose.connection.collection('settings').deleteMany({});
  });

  it('public /config has defaults; only the super admin can read/update settings', async () => {
    const c = await request(app).get('/config');
    expect(c.body).toMatchObject({ trialDays: 30, referral: { rate: 0.2 }, supportWhatsApp: '' });

    await login('own|owner@example.com');
    await login('u7|user@example.com');
    expect((await request(app).put('/admin/settings').set('authorization', 'Bearer u7|user@example.com').send({ trialDays: 9 })).status).toBe(403);

    const put = await request(app)
      .put('/admin/settings')
      .set('authorization', 'Bearer own|owner@example.com')
      .send({ supportWhatsApp: '01712345678', trialDays: 15, referralRate: 0.1, paymentNumbers: { bkash: '01700000000' }, telegramChatIds: ['987654321'] });
    expect(put.status).toBe(200);

    const after = await request(app).get('/config');
    expect(after.body).toMatchObject({ supportWhatsApp: '01712345678', trialDays: 15, referral: { rate: 0.1 }, paymentNumbers: { bkash: '01700000000' } });
    expect(after.body.telegramChatIds).toBeUndefined(); // never public
  });

  it('a new account uses the dashboard trial days; bad values are rejected', async () => {
    await login('own|owner@example.com');
    await request(app).put('/admin/settings').set('authorization', 'Bearer own|owner@example.com').send({ trialDays: 15 });
    const r = await login('n1|new@example.com');
    const days = (Date.parse(r.body.user.subscription.expiresAt) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(15);
    const bad = await request(app).put('/admin/settings').set('authorization', 'Bearer own|owner@example.com').send({ telegramChatIds: ['abc'] });
    expect(bad.status).toBe(400);
  });
});

describe('one-time referral after sign-up (e.g. Google users)', () => {
  it('adds once, rejects own code / unknown / second time; canAddReferral flips to false', async () => {
    const a = await login('ra|ref@example.com');
    const b = await login('rb|new@example.com'); // signed up without a code
    expect(b.body.user.canAddReferral).toBe(true);
    const auth = { authorization: 'Bearer rb|new@example.com' };
    expect((await request(app).post('/me/referral').set(auth).send({ referralCode: b.body.user.referralCode })).body.error).toBe('own_code');
    expect((await request(app).post('/me/referral').set(auth).send({ referralCode: 'JKZZZZZZ' })).status).toBe(404);
    const ok = await request(app).post('/me/referral').set(auth).send({ referralCode: a.body.user.referralCode });
    expect(ok.status).toBe(200);
    expect(ok.body.user.canAddReferral).toBe(false);
    expect((await request(app).post('/me/referral').set(auth).send({ referralCode: a.body.user.referralCode })).status).toBe(409);
    const me = await request(app).get('/me').set('authorization', 'Bearer ra|ref@example.com');
    expect(me.body.user.referralStats.referredUsers).toBe(1);
  });

  it('closed after 7 days', async () => {
    await login('old|old@example.com');
    await User.collection.updateOne({ firebaseUid: 'old' }, { $set: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    const r = await request(app).post('/me/referral').set('authorization', 'Bearer old|old@example.com').send({ referralCode: 'JKABCDEF' });
    expect(r.status).toBe(410);
  });
});

describe('admin: users & subscriptions', () => {
  const admin = { authorization: 'Bearer own|owner@example.com' };
  beforeEach(async () => {
    await mongoose.connection.collection('subscriptionlogs').deleteMany({});
  });

  it('only the super admin; stats and search', async () => {
    await login('own|owner@example.com');
    const u = await login('s1|shop1@example.com');
    expect((await request(app).get('/admin/stats').set('authorization', 'Bearer s1|shop1@example.com')).status).toBe(403);
    const stats = await request(app).get('/admin/stats').set(admin);
    expect(stats.body).toMatchObject({ total: 2, trial: 2, paid: 0, expired: 0 });
    expect(stats.body.signupsByDay).toHaveLength(30);
    expect(stats.body.signupsByDay.at(-1).users).toBe(2);
    expect(stats.body.revenueByMonth).toHaveLength(6);
    const found = await request(app).get('/admin/users').query({ q: u.body.user.accountId }).set(admin);
    expect(found.body.users).toHaveLength(1);
    expect(found.body.users[0].subscription.daysLeft).toBeGreaterThan(0);
  });

  it('extend adds on top of the remaining time, is logged, and the user sees it', async () => {
    await login('own|owner@example.com');
    const u = await login('s2|shop2@example.com');
    const id = u.body.user.accountId;
    const before = Date.parse(u.body.user.subscription.expiresAt);
    const r = await request(app)
      .post(`/admin/users/${id}/subscription`)
      .set(admin)
      .send({ action: 'extend', days: 180, plan: '6m', amount: 999, method: 'bkash', trxId: 'ABC123' });
    expect(r.status).toBe(200);
    expect(Math.round((Date.parse(r.body.user.subscription.expiresAt) - before) / 86_400_000)).toBe(180); // trial days kept
    expect(r.body.user.subscription.status).toBe('active');
    const detail = await request(app).get(`/admin/users/${id}`).set(admin);
    expect(detail.body.history[0]).toMatchObject({ action: 'extend', days: 180, amount: 999, trxId: 'ABC123', by: 'owner@example.com' });
    const sub = await request(app).get('/subscription').set('authorization', 'Bearer s2|shop2@example.com');
    expect(sub.body.status).toBe('active');
  });

  it('expire now → user sees expired; block/unblock; super admin cannot be blocked', async () => {
    const own = await login('own|owner@example.com');
    const u = await login('s3|shop3@example.com');
    const id = u.body.user.accountId;
    await request(app).post(`/admin/users/${id}/subscription`).set(admin).send({ action: 'expire' });
    const sub = await request(app).get('/subscription').set('authorization', 'Bearer s3|shop3@example.com');
    expect(sub.body.status).toBe('expired');
    expect((await request(app).post(`/admin/users/${id}/status`).set(admin).send({ status: 'blocked' })).body.user.status).toBe('blocked');
    expect((await request(app).post(`/admin/users/${own.body.user.accountId}/status`).set(admin).send({ status: 'blocked' })).status).toBe(400);
  });
});

describe('payments: request → approve / reject', () => {
  const admin = { authorization: 'Bearer own|owner@example.com' };
  beforeEach(async () => {
    await mongoose.connection.collection('paymentrequests').deleteMany({});
    await mongoose.connection.collection('settings').deleteMany({});
  });

  it('user submits (price from server plans), duplicate TrxID refused, admin approves once → +days, Telegram', async () => {
    await login('own|owner@example.com');
    const u = await login('p1|pay@example.com');
    const auth = { authorization: 'Bearer p1|pay@example.com' };
    const cfg = await request(app).get('/config');
    expect(cfg.body.plans.map((p: { key: string }) => p.key)).toEqual(['1m', '6m', '12m']);
    const r = await request(app).post('/me/payments').set(auth).send({ plan: '6m', method: 'bkash', trxId: 'trx9abc', amount: 1 });
    expect(r.status).toBe(201);
    expect(r.body.request).toMatchObject({ amount: 999, days: 180, trxId: 'TRX9ABC', status: 'pending' }); // client "amount" ignored
    expect(sent.some((t) => t.includes('NEW PAYMENT REQUEST') && t.includes('TRX9ABC') && t.includes('pay@example.com'))).toBe(true);
    expect((await request(app).post('/me/payments').set(auth).send({ plan: '1m', method: 'bkash', trxId: 'TRX9ABC' })).status).toBe(409);

    const list = await request(app).get('/admin/payments').set(admin);
    expect(list.body.pending).toBe(1);
    const id = list.body.requests[0]._id;
    const before = Date.parse(u.body.user.subscription.expiresAt);
    const ok = await request(app).post(`/admin/payments/${id}/approve`).set(admin);
    expect(ok.status).toBe(200);
    expect((await request(app).post(`/admin/payments/${id}/approve`).set(admin)).status).toBe(409); // no double extend
    const me = await request(app).get('/me').set(auth);
    expect(Math.round((Date.parse(me.body.user.subscription.expiresAt) - before) / 86_400_000)).toBe(180);
    expect(me.body.user.subscription.status).toBe('active');

    // undo the approval (wrong click): back to exactly the trial it was, logged
    expect((await request(app).post(`/admin/payments/${id}/revoke`).set(admin).send({})).status).toBe(400);
    const rv = await request(app).post(`/admin/payments/${id}/revoke`).set(admin).send({ reason: 'ভুল করে' });
    expect(rv.body.request.status).toBe('revoked');
    const back = await request(app).get('/me').set(auth);
    expect(Date.parse(back.body.user.subscription.expiresAt)).toBe(before);
    expect(back.body.user.subscription.status).toBe('trial');
    expect((await request(app).post(`/admin/payments/${id}/revoke`).set(admin).send({ reason: 'x' })).status).toBe(409);
  });

  it('reject needs a reason; non-admin cannot list', async () => {
    await login('own|owner@example.com');
    await login('p2|pay2@example.com');
    const auth = { authorization: 'Bearer p2|pay2@example.com' };
    const r = await request(app).post('/me/payments').set(auth).send({ plan: '1m', method: 'nagad', trxId: 'NG12345' });
    expect((await request(app).get('/admin/payments').set(auth)).status).toBe(403);
    expect((await request(app).post(`/admin/payments/${r.body.request._id}/reject`).set(admin).send({})).status).toBe(400);
    const rej = await request(app).post(`/admin/payments/${r.body.request._id}/reject`).set(admin).send({ reason: 'TrxID মেলেনি' });
    expect(rej.body.request.status).toBe('rejected');
    const mine = await request(app).get('/me/payments').set(auth);
    expect(mine.body.requests[0]).toMatchObject({ status: 'rejected', reason: 'TrxID মেলেনি' });
  });
});


describe('admin search & user extras', () => {
  const admin = { authorization: 'Bearer own|owner@example.com' };
  it('shop identity from the app; Bangla/English digits both match; login method; promoter toggle', async () => {
    await login('own|owner@example.com');
    await login('g1|g1@example.com|google.com');
    const auth = { authorization: 'Bearer g1|g1@example.com|google.com' };
    expect((await request(app).put('/me/profile').set(auth).send({ shopName: 'মায়ের দোয়া স্টোর', ownerName: 'রহিম', phone: '০১৭১২৩৪৫৬৭৮' })).status).toBe(200);
    for (const q of ['01712', '০১৭১২', 'মায়ের দোয়া', 'রহিম']) {
      const r = await request(app).get('/admin/users').query({ q }).set(admin);
      expect(r.body.users.map((u: { email: string }) => u.email), q).toEqual(['g1@example.com']);
    }
    const id = (await request(app).get('/admin/users').query({ q: 'g1@' }).set(admin)).body.users[0];
    expect(id.signInProvider).toBe('google.com');
    expect(id.ownerName).toBe('রহিম');
    const p = await request(app).post(`/admin/users/${id.accountId}/referrer-type`).set(admin).send({ referrerType: 'promoter' });
    expect(p.body.user.referrerType).toBe('promoter');
  });
});

describe('bug reports', () => {
  it('guest and signed-in users can report; admin lists and resolves; owner can turn it off', async () => {
    await login('owner|owner@example.com');
    await login('r1|r1@example.com');
    const guest = await request(app).post('/reports').send({ message: 'বিক্রি সেভ হয় না', page: '/app · sales', appVersion: '0.3.1', shopName: 'করিম স্টোর', reporterName: 'করিম', reporterPhone: '01811000000' });
    expect(guest.status).toBe(201);
    expect(sent.at(-1)).toMatch(/Guest/);
    expect(sent.at(-1)).toMatch(/01811000000/);
    const signed = await request(app).post('/reports').set('authorization', 'Bearer r1|r1@example.com').send({ message: 'রিপোর্ট খোলে না' });
    expect(signed.status).toBe(201);
    expect(sent.at(-1)).toMatch(/r1@example.com/);
    expect((await request(app).post('/reports').send({ message: 'x' })).status).toBe(400);

    expect((await request(app).get('/admin/reports').set('authorization', 'Bearer r1|r1@example.com')).status).toBe(403);
    const list = await request(app).get('/admin/reports').set('authorization', 'Bearer owner|owner@example.com');
    expect(list.body.open).toBe(2);
    const id = list.body.reports.find((r: { email: string }) => r.email === 'r1@example.com')._id;
    const done = await request(app).post(`/admin/reports/${id}/status`).set('authorization', 'Bearer owner|owner@example.com').send({ status: 'resolved' });
    expect(done.body.report.resolvedBy).toBe('owner@example.com');

    await request(app).put('/admin/settings').set('authorization', 'Bearer owner|owner@example.com').send({ bugReportEnabled: false, supportEmail: 'help@example.com' });
    const cfg = await request(app).get('/config');
    expect(cfg.body).toMatchObject({ bugReportEnabled: false, supportEmail: 'help@example.com' });
    expect((await request(app).post('/reports').send({ message: 'আবার সমস্যা' })).status).toBe(403);
    await request(app).put('/admin/settings').set('authorization', 'Bearer owner|owner@example.com').send({ bugReportEnabled: true });
  });
});

describe('plans, QR and tutorial videos from settings', () => {
  it('defaults: true savings on 6m/12m; owner can set a list price, badge, QR and video links', async () => {
    await request(app).put('/admin/settings').set('authorization', 'Bearer owner|owner@example.com').send({});
    await login('owner|owner@example.com');
    const admin = { authorization: 'Bearer owner|owner@example.com' };
    await mongoose.connection.collection('settings').deleteMany({});
    const cfg = await request(app).get('/config');
    expect(cfg.body.plans[1]).toMatchObject({ key: '6m', price: 999, listPrice: 1194 });
    expect(cfg.body.paymentQr).toBeUndefined(); // kept out of the light /config
    expect(cfg.body.tutorialVideos.every((v: { url: string }) => v.url)).toBe(true); // empty links hidden
    const qr = 'data:image/png;base64,iVBORw0KGgo=';
    const plans = [{ key: '1m', label: '১ মাস', days: 30, price: 199, listPrice: 250, badge: 'লঞ্চ অফার' }];
    expect((await request(app).put('/admin/settings').set(admin).send({ paymentQr: { bkash: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await request(app).put('/admin/settings').set(admin).send({ plans, paymentQr: { bkash: qr } })).status).toBe(200);
    expect((await request(app).get('/config')).body.plans[0]).toMatchObject({ listPrice: 250, badge: 'লঞ্চ অফার' });
    expect((await request(app).get('/config/payment-qr')).body.paymentQr).toMatchObject({ bkash: qr, nagad: '' });
  });
});

describe('cloud backup', () => {
  it('save, meta, restore; the old copy is kept as previous; needs login', async () => {
    await login('c1|c1@example.com');
    const auth = { authorization: 'Bearer c1|c1@example.com' };
    expect((await request(app).get('/me/backup/meta')).status).toBe(401);
    expect((await request(app).get('/me/backup/meta').set(auth)).body).toEqual({ exists: false });
    expect((await request(app).get('/me/backup').set(auth)).status).toBe(404);
    const big = 'x'.repeat(1_500_000); // over the general 1 MB limit, under the backup limit
    const put = await request(app).put('/me/backup').set(auth).send({ encoding: 'plain', payload: big, size: big.length, shopName: 'রহিম স্টোর' });
    expect(put.status).toBe(200);
    await request(app).put('/me/backup').set(auth).send({ encoding: 'plain', payload: '{"second":true}', size: 15 });
    const meta = await request(app).get('/me/backup/meta').set(auth);
    expect(meta.body).toMatchObject({ exists: true, size: 15 });
    const got = await request(app).get('/me/backup').set(auth);
    expect(got.body.payload).toBe('{"second":true}');
    const doc = await mongoose.connection.collection('cloudbackups').findOne({});
    expect(doc?.previous?.payload.length).toBe(1_500_000);
  });
});

describe('telegram message look', () => {
  it('bold title, one fact per line, View button (text link on localhost)', () => {
    const a: Alert = { title: '🆕 NEW USER', rows: [['Name', 'Rahim <Store>'], ['User ID', 'JK-1234-5678'], ['Phone', '']], button: { text: 'View user', url: 'https://jk.app/admin/users/JK-1234-5678' } };
    const live = renderAlert(a);
    expect(live.text).toBe(['<b>🆕 NEW USER</b>', '', 'Name: <b>Rahim &lt;Store&gt;</b>', 'User ID: <b>JK-1234-5678</b>'].join('\n'));
    expect(live.reply_markup).toEqual({ inline_keyboard: [[{ text: 'View user ↗', url: 'https://jk.app/admin/users/JK-1234-5678' }]] });
    const local = renderAlert({ ...a, button: { text: 'View user', url: 'http://localhost:3000/admin/users/x' } });
    expect(local.reply_markup).toBeUndefined();
    expect(local.text).toContain('View user: http://localhost:3000/admin/users/x');
  });
});

describe('admin link for Telegram', () => {
  it('uses ADMIN_URL, else the live frontend from CORS_ORIGINS + /admin', async () => {
    const { adminUrl } = await import('../src/config.js');
    expect(adminUrl({ ADMIN_URL: 'https://x.app/admin/', CORS_ORIGINS: '' })).toBe('https://x.app/admin');
    expect(adminUrl({ ADMIN_URL: '', CORS_ORIGINS: 'http://localhost:3000,https://jk.vercel.app' })).toBe('https://jk.vercel.app/admin');
    expect(adminUrl({ ADMIN_URL: '', CORS_ORIGINS: 'http://localhost:3000' })).toBe('http://localhost:3000/admin');
  });
});

describe('Vercel deploy safety', () => {
  it('private key survives dashboard pastes (quotes, CRLF, literal \n, spaces)', async () => {
    const { cleanPrivateKey } = await import('../src/bootstrap.js');
    const want = '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n';
    expect(cleanPrivateKey('"-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n"')).toBe(want);
    expect(cleanPrivateKey('  -----BEGIN PRIVATE KEY-----\r\nABC\r\n-----END PRIVATE KEY-----\r\n ')).toBe(want.trimEnd());
  });
  it('zero-config entry: src/index.ts default-exports an Express app; no api/ or vercel.json', async () => {
    const fs = await import('node:fs');
    expect(fs.existsSync('api')).toBe(false);
    expect(fs.existsSync('vercel.json')).toBe(false);
    expect(fs.readFileSync('src/index.ts', 'utf8')).toMatch(/export default app;/);
    expect(fs.readFileSync('src/index.ts', 'utf8')).toMatch(/!process\.env\.VERCEL/);
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(pkg.overrides.jose).toBe('5.10.0');
    expect(pkg.devDependencies.typescript).toMatch(/^\^?5\./);
  });
});
