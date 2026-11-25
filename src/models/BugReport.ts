/**
 * "সমস্যা জানান" — a short problem report from the app (owner, 2026-11-25). Who (account or guest),
 * where (page), what (one message), plus app version and device for reproducing it.
 */
import mongoose, { Schema } from 'mongoose';

const bugReportSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    accountId: { type: String, default: '' },
    email: { type: String, default: '' },
    shopName: { type: String, default: '' },
    message: { type: String, required: true },
    /** App screen it was sent from (e.g. "/app · sales"). */
    page: { type: String, default: '' },
    appVersion: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
    resolvedBy: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
bugReportSchema.index({ createdAt: -1 });

export const BugReport = mongoose.models.BugReport ?? mongoose.model('BugReport', bugReportSchema);
