/**
 * Every subscription change made by an admin: who, when, before → after, money and note.
 * Append-only; it answers "why does this shop's subscription end on this date?".
 */
import mongoose, { Schema } from 'mongoose';

const logSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: String, required: true, index: true },
    action: { type: String, enum: ['extend', 'set_date', 'expire', 'revoke'], required: true },
    plan: { type: String, default: '' },
    days: { type: Number, default: 0 },
    before: { type: Date, required: true },
    after: { type: Date, required: true },
    amount: { type: Number, default: 0 },
    method: { type: String, default: '' }, // bkash / nagad / bank / cash / free
    trxId: { type: String, default: '' },
    note: { type: String, default: '' },
    by: { type: String, required: true }, // admin email
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const SubscriptionLog = mongoose.models.SubscriptionLog ?? mongoose.model('SubscriptionLog', logSchema);
