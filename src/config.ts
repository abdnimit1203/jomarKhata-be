/**
 * All settings come from environment variables (.env locally, the host's settings in production).
 * The server refuses to start with a clear message when a required value is missing.
 */
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /** Comma-separated frontend origins allowed to call the API (CORS). */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required (MongoDB Atlas connection string)'),
  /** Database inside the cluster (case-sensitive). Used even when the URI names none. */
  MONGODB_DB_NAME: z.string().min(1).default('JomarKhata'),

  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  FIREBASE_CLIENT_EMAIL: z.string().min(1, 'FIREBASE_CLIENT_EMAIL is required'),
  /** The private key from the service-account JSON. "\n" sequences are turned into real newlines. */
  FIREBASE_PRIVATE_KEY: z.string().min(1, 'FIREBASE_PRIVATE_KEY is required'),

  /** Comma-separated emails that get the super_admin role. */
  SUPER_ADMIN_EMAILS: z.string().default(''),

  /** Default trial for a new account (days). Later editable from the admin settings. */
  TRIAL_DAYS: z.coerce.number().int().min(0).default(30),

  /** Optional: new-account / payment alerts to Telegram. Leave empty to turn off. */
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ADMIN_CHAT_ID: z.string().default(''),
  /** ImageKit (same account as the owner's other shop; files under /jomarkhata). Empty = uploads off. */
  IMAGEKIT_PUBLIC_KEY: z.string().default(''),
  IMAGEKIT_PRIVATE_KEY: z.string().default(''),
  IMAGEKIT_URL_ENDPOINT: z.string().default(''),
  /** Public URL of the admin panel, used in Telegram links (e.g. https://your-domain/admin). */
  ADMIN_URL: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment. Fill these in .env (see .env.example):\n${lines}`);
  }
  return parsed.data;
}

/**
 * Admin panel URL for Telegram links. ADMIN_URL if set; otherwise the first non-localhost
 * frontend in CORS_ORIGINS + "/admin" (so production needs no extra variable).
 */
export function adminUrl(config: Pick<Config, 'ADMIN_URL' | 'CORS_ORIGINS'>): string {
  if (config.ADMIN_URL) return config.ADMIN_URL.replace(/\/$/, '');
  const origins = list(config.CORS_ORIGINS);
  const live = origins.find((o) => !/localhost|127\.0\.0\.1/.test(o)) ?? origins[0] ?? '';
  return live ? `${live.replace(/\/$/, '')}/admin` : '';
}

export const list = (csv: string) =>
  csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
