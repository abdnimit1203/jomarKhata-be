/**
 * A shop owner's subscription payment: they pay by bKash / Nagad / bank and send the TrxID from
 * the app. It stays "pending" until the super admin approves (→ subscription extended, logged) or
 * rejects it (with a reason). Approved requests are the "orders".
 */
import mongoose, { Schema } from 'mongoose';

const paymentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: String, required: true, index: true },
    email: { type: String, default: '' },
    shopName: { type: String, default: '' },
    plan: { type: String, required: true }, // key from settings.plans
    planLabel: { type: String, default: '' },
    days: { type: Number, required: true },
    amount: { type: Number, required: true },
    method: { type: String, enum: ['bkash', 'nagad', 'bank'], required: true },
    payerNumber: { type: String, default: '' },
    trxId: { type: String, required: true, trim: true },
    note: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'revoked'], default: 'pending', index: true },
    decidedBy: { type: String, default: '' },
    decidedAt: { type: Date, default: null },
    reason: { type: String, default: '' },
    expiresAtAfter: { type: Date, default: null },
    /** The user's subscription just before approval, so an approval can be undone exactly. */
    subscriptionBefore: { status: String, plan: String, expiresAt: Date },
    revokedBy: { type: String, default: '' },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// one TrxID can't be submitted twice for the same method
paymentSchema.index({ method: 1, trxId: 1 }, { unique: true });

export const PaymentRequest = mongoose.models.PaymentRequest ?? mongoose.model('PaymentRequest', paymentSchema);
