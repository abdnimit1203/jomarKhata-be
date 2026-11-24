/** Long-running server entry (local dev, Render / Railway / VPS). Vercel uses api/index.ts instead. */
import mongoose from 'mongoose';
import { getApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const { PORT } = loadConfig();
const app = await getApp();
const server = app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));

const shutdown = () => {
  server.close(() => void mongoose.disconnect().then(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
