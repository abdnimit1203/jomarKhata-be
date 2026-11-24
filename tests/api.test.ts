/**
 * API tests against an in-memory MongoDB and a fake Firebase token verifier (no network).
 * Token format in tests: "uid|email" (verified), "bad" → rejected.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type VerifyToken } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { newAccountId, newReferralCode, normalizeReferralCode } from '../src/lib/ids.js';
import { User } from '../src/models/User.js';

let mongo: MongoMemoryServer;
const sent: string[] = [];
const verifyToken: VerifyToken = async (t) => {
  if (t === 'bad') throw new Error('invalid');
  const [uid, email] = t.split('|');
  return { uid, email: email || undefined, email_verified: true };
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
const app = createApp({ config, verifyToken, telegram: { enabled: true, notify: async (t: string) => void sent.push(t) } });
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
    expect(sent[0]).toContain('নতুন অ্যাকাউন্ট');

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
