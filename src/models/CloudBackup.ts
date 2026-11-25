/**
 * Cloud copy of a shop's khata (owner, 2026-11-25: "ক্লাউডে সিঙ্ক করে রাখো"). One document per user
 * with the latest backup and the one before it (so a bad upload never wipes the only copy).
 * `payload` is the app's own backup file (checksummed JSON), gzip+base64 when the phone supports it.
 * This is a whole-khata snapshot, not record-by-record sync between phones.
 */
import mongoose, { Schema } from 'mongoose';

const copy = {
  encoding: { type: String, enum: ['gzip-base64', 'plain'], required: true },
  payload: { type: String, required: true },
  size: { type: Number, required: true }, // bytes of the original JSON
  shopName: { type: String, default: '' },
  appVersion: { type: String, default: '' },
  savedAt: { type: Date, required: true },
};

const cloudBackupSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    accountId: { type: String, required: true, index: true },
    current: copy,
    previous: { type: new Schema(copy, { _id: false }), default: null },
  },
  { timestamps: true },
);

export const CloudBackup = mongoose.models.CloudBackup ?? mongoose.model('CloudBackup', cloudBackupSchema);
