/**
 * Everything the owner may change WITHOUT touching env or code (owner, 2026-11-24): one document,
 * edited from the super-admin dashboard (PUT /admin/settings). Secrets (DB URI, Firebase keys,
 * Telegram bot TOKEN) stay in .env; the Telegram chat IDs (who receives alerts) live here.
 */
import mongoose, { Schema } from 'mongoose';

const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'global' },
    supportWhatsApp: { type: String, default: '' },
    trialDays: { type: Number, default: 30, min: 0, max: 365 },
    referralRate: { type: Number, default: 0.2, min: 0, max: 1 },
    paymentNumbers: {
      bkash: { type: String, default: '' },
      nagad: { type: String, default: '' },
      bank: { type: String, default: '' },
    },
    /** Plans shown in the app's "নবায়ন" screen; price in taka. Editable in admin settings. */
    plans: {
      type: [{ _id: false, key: String, label: String, days: Number, price: Number }],
      default: undefined,
    },
    /** Who receives Telegram alerts (the bot token itself stays in .env). */
    telegramChatIds: { type: [String], default: [] },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true },
);

export const Settings = mongoose.models.Settings ?? mongoose.model('Settings', settingsSchema);

export interface SettingsValue {
  supportWhatsApp: string;
  trialDays: number;
  referralRate: number;
  paymentNumbers: { bkash: string; nagad: string; bank: string };
  telegramChatIds: string[];
  plans: Plan[];
}

export interface Plan {
  key: string;
  label: string;
  days: number;
  price: number;
}

export const DEFAULT_PLANS: Plan[] = [
  { key: '1m', label: '১ মাস', days: 30, price: 199 },
  { key: '6m', label: '৬ মাস', days: 180, price: 999 },
  { key: '12m', label: '১ বছর', days: 365, price: 1799 },
];

/** Current settings; created with defaults on first use. `fallback` fills from env until edited. */
export async function getSettings(fallback: Partial<SettingsValue> = {}): Promise<SettingsValue> {
  const doc = (await Settings.findById('global').lean()) as Partial<SettingsValue> | null;
  return {
    supportWhatsApp: doc?.supportWhatsApp ?? fallback.supportWhatsApp ?? '',
    trialDays: doc?.trialDays ?? fallback.trialDays ?? 30,
    referralRate: doc?.referralRate ?? fallback.referralRate ?? 0.2,
    paymentNumbers: { bkash: '', nagad: '', bank: '', ...(doc?.paymentNumbers ?? {}) },
    telegramChatIds: doc?.telegramChatIds?.length ? doc.telegramChatIds : (fallback.telegramChatIds ?? []),
    plans: doc?.plans?.length ? doc.plans : DEFAULT_PLANS,
  };
}
