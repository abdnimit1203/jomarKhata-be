/**
 * Entry for BOTH hosting styles (Vercel zero-config Express — no api/ folder, no vercel.json):
 *   - Vercel imports this file and uses the DEFAULT EXPORT (an Express app) as one function.
 *   - Locally / on a normal server, `npm run dev` or `npm start` runs it and it listens on PORT.
 * The real app (Firebase Admin + MongoDB + routes) is built once per process by getApp(); this
 * thin outer app hands every request to it, and returns a readable 503 if startup failed.
 */
import express from 'express';
import { getApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  getApp()
    .then((inner) => inner(req, res, next))
    .catch((err: unknown) => {
      console.error('[startup]', err);
      res.status(503).json({ error: 'unavailable', message: 'সার্ভার চালু হতে সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করুন।' });
    });
});

// Never listen under Vercel (it calls the exported app itself) or in tests.
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  const { PORT } = loadConfig();
  getApp()
    .then(() => app.listen(PORT, () => console.log(`[api] listening on :${PORT}`)))
    .catch((err: unknown) => {
      console.error('[startup]', err);
      process.exit(1);
    });
}

export default app;
