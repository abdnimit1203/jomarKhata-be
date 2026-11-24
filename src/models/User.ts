/**
 * One account per Firebase user. Passwords are never stored here: Firebase Authentication keeps
 * and hashes them. This record holds the shop owner's profile, IDs, referral and subscription.
 */
import mongoose, { type InferSchemaType, Schema } from 'mongoose';

const subscriptionSchema = new Schema(
  {
    status: { type: String, enum: ['trial', 'active', 'expired'], default: 'trial' },
    plan: { type: String, default: 'trial' },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    firebaseUid: { type: String, required: true, unique: true, index: true },
    accountId: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    emailVerified: { type: Boolean, default: false },
    displayName: { type: String, default: '' },
    phone: { type: String, default: '' },
    shopName: { type: String, default: '' },
    ownerName: { type: String, default: '' },
    /** How they sign in: 'google.com' or 'password' (from the Firebase token). */
    signInProvider: { type: String, default: '' },
    role: { type: String, enum: ['user', 'super_admin'], default: 'user' },
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },

    /** Own code to share; unique across all users. */
    referralCode: { type: String, required: true, unique: true },
    /** Who brought this user (set once at account creation, never by the client later). */
    referredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    referrerType: { type: String, enum: ['regular', 'promoter'], default: 'regular' },

    subscription: { type: subscriptionSchema, required: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date };

/** A referral code can be added once, within this many days of opening the account. */
export const REFERRAL_CLAIM_DAYS = 7;

export function canAddReferral(u: UserDoc): boolean {
  return !u.referredBy && Date.now() - new Date(u.createdAt).getTime() < REFERRAL_CLAIM_DAYS * 86_400_000;
}
export const User = mongoose.models.User ?? mongoose.model('User', userSchema);

/** What the app receives (no internal fields). */
export function publicUser(u: UserDoc, stats: { referredUsers: number }) {
  return {
    accountId: u.accountId,
    email: u.email,
    displayName: u.displayName,
    phone: u.phone || undefined,
    shopName: u.shopName,
    role: u.role,
    referralCode: u.referralCode,
    referralStats: {
      referredUsers: stats.referredUsers,
      referrerType: u.referrerType,
      commissionEarned: 0, // filled by the commission ledger once payments exist
      freeDaysEarned: 0,
    },
    subscription: {
      status: u.subscription.expiresAt.getTime() < Date.now() ? 'expired' : u.subscription.status,
      plan: u.subscription.plan,
      expiresAt: u.subscription.expiresAt,
    },
    /** true = no referrer yet and still inside the one-time window (the app may offer "কোড দিন"). */
    canAddReferral: canAddReferral(u),
  };
}
