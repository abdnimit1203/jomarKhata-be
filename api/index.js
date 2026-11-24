/**
 * Vercel serverless entry (plain JavaScript on purpose: Vercel runs it as-is, no TypeScript step).
 * `npm run build` (vercel.json → buildCommand) compiles src/ to dist/ first; this file only loads
 * the compiled app. Every path is rewritten here (vercel.json) and handed to Express.
 */
import { getApp } from '../dist/bootstrap.js';

export default async function handler(req, res) {
  try {
    const app = await getApp();
    app(req, res);
  } catch (err) {
    console.error('[startup]', err);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'unavailable', message: 'সার্ভার চালু হতে সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করুন।', detail: String(err && err.message ? err.message : err).slice(0, 300) }));
  }
}
