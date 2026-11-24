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
} as NodeJS.ProcessEnv);
const app = createApp({ config, verifyToken, telegram: { enabled: true, notify: (t) => void sent.push(t) } });
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
