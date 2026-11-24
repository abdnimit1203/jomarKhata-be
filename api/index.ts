/**
 * Vercel serverless entry: every path is rewritten here (vercel.json) and handed to the Express app.
 * The app (DB connection, Firebase Admin) is built once per warm instance.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getApp } from '../src/bootstrap.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await getApp();
    app(req as never, res as never);
  } catch (err) {
    console.error('[startup]', err);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'unavailable', message: 'সার্ভার চালু হতে সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করুন।' }));
  }
}
