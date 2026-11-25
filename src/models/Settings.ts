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
    /** Helpline email shown in the app's settings (empty = hidden). */
    supportEmail: { type: String, default: '' },
    /** Floating "সমস্যা জানান" button in the app; the owner turns it off from the dashboard. */
    bugReportEnabled: { type: Boolean, default: true },
    trialDays: { type: Number, default: 30, min: 0, max: 365 },
    referralRate: { type: Number, default: 0.2, min: 0, max: 1 },
    paymentNumbers: {
      bkash: { type: String, default: '' },
      nagad: { type: String, default: '' },
      bank: { type: String, default: '' },
    },
    /** Plans shown in the app's "নবায়ন" screen; price in taka. Editable in admin settings. */
    plans: {
      type: [{ _id: false, key: String, label: String, days: Number, price: Number, listPrice: Number, badge: String }],
      default: undefined,
    },
    /** QR images for the renew screen, as small data URLs (PNG/JPEG, resized in the admin panel). */
    paymentQr: {
      bkash: { type: String, default: '' },
      nagad: { type: String, default: '' },
      bank: { type: String, default: '' },
    },
    /** Tutorial videos (YouTube links) shown on the landing page and in the app. */
    tutorialVideos: { type: [{ _id: false, title: String, url: String }], default: undefined },
    /** Who receives Telegram alerts (the bot token itself stays in .env). */
    telegramChatIds: { type: [String], default: [] },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true },
);

export const Settings = mongoose.models.Settings ?? mongoose.model('Settings', settingsSchema);

export interface SettingsValue {
  supportWhatsApp: string;
  supportEmail: string;
  bugReportEnabled: boolean;
  trialDays: number;
  referralRate: number;
  paymentNumbers: { bkash: string; nagad: string; bank: string };
  paymentQr: { bkash: string; nagad: string; bank: string };
  telegramChatIds: string[];
  plans: Plan[];
  tutorialVideos: TutorialVideo[];
}

export interface TutorialVideo {
  title: string;
  url: string;
}

export interface Plan {
  key: string;
  label: string;
  days: number;
  price: number;
  /** Optional "before" price shown struck through (e.g. 6 x the monthly price). 0/absent = none. */
  listPrice?: number;
  /** Optional small label on the plan card, e.g. "সবচেয়ে জনপ্রিয়", "লঞ্চ অফার". */
  badge?: string;
}

// listPrice for 6m / 12m = the same months at the monthly price (a true saving, not a made-up one).
export const DEFAULT_PLANS: Plan[] = [
  { key: '1m', label: '১ মাস', days: 30, price: 199 },
  { key: '6m', label: '৬ মাস', days: 180, price: 999, listPrice: 1194, badge: 'সবচেয়ে জনপ্রিয়' },
  { key: '12m', label: '১ বছর', days: 365, price: 1799, listPrice: 2388, badge: 'সবচেয়ে সাশ্রয়ী' },
];

export const DEFAULT_TUTORIALS: TutorialVideo[] = [
  { title: 'জমারখাতা কী?', url: 'https://youtube.com/shorts/u9SRRsnLCVA' },
  { title: 'ফোনে ইনস্টল আর খাতা খোলা', url: '' },
  { title: 'বিক্রি লেখা', url: 'https://youtube.com/shorts/T9aNWPitceE' },
  { title: 'বাকির হিসাব', url: 'https://youtube.com/shorts/g-W9wEQuml0' },
  { title: 'পুরো টিউটোরিয়াল', url: 'https://youtube.com/shorts/W9l7I4PHLw0' },
];

/** Current settings; created with defaults on first use. `fallback` fills from env until edited. */
export async function getSettings(fallback: Partial<SettingsValue> = {}): Promise<SettingsValue> {
  const doc = (await Settings.findById('global').lean()) as Partial<SettingsValue> | null;
  return {
    supportWhatsApp: doc?.supportWhatsApp ?? fallback.supportWhatsApp ?? '',
    supportEmail: doc?.supportEmail ?? fallback.supportEmail ?? '',
    bugReportEnabled: doc?.bugReportEnabled ?? fallback.bugReportEnabled ?? true,
    trialDays: doc?.trialDays ?? fallback.trialDays ?? 30,
    referralRate: doc?.referralRate ?? fallback.referralRate ?? 0.2,
    paymentNumbers: { bkash: '', nagad: '', bank: '', ...(doc?.paymentNumbers ?? {}) },
    paymentQr: { bkash: '', nagad: '', bank: '', ...(doc?.paymentQr ?? {}) },
    tutorialVideos: doc?.tutorialVideos?.length ? doc.tutorialVideos : DEFAULT_TUTORIALS,
    telegramChatIds: doc?.telegramChatIds?.length ? doc.telegramChatIds : (fallback.telegramChatIds ?? []),
    plans: doc?.plans?.length ? doc.plans : DEFAULT_PLANS,
  };
}
