/**
 * ImageKit without the SDK (two small calls; nothing that can break the Vercel TypeScript build).
 * - authParams(): short-lived signed params so the BROWSER uploads straight to ImageKit; the private
 *   key never leaves the server.
 * - deleteFile(): removes a replaced image, so one user only ever has one avatar stored (free plan).
 * - isOurFile(): a saved URL must be inside our root folder on our ImageKit endpoint.
 * Every file lives under ROOT_FOLDER (the frontend's lib/upload.ts adds the same prefix).
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Config } from '../config.js';

export const ROOT_FOLDER = '/jomarkhata';
export type UploadFolder = '/avatars' | '/payment-qr';

export function makeImageKit(config: Pick<Config, 'IMAGEKIT_PUBLIC_KEY' | 'IMAGEKIT_PRIVATE_KEY' | 'IMAGEKIT_URL_ENDPOINT'>) {
  const endpoint = config.IMAGEKIT_URL_ENDPOINT.replace(/\/$/, '');
  return {
    enabled: Boolean(config.IMAGEKIT_PRIVATE_KEY && config.IMAGEKIT_PUBLIC_KEY && endpoint),

    authParams() {
      const token = randomUUID();
      const expire = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes
      const signature = createHmac('sha1', config.IMAGEKIT_PRIVATE_KEY).update(token + expire).digest('hex');
      return { token, expire, signature, publicKey: config.IMAGEKIT_PUBLIC_KEY };
    },

    /** true when the URL is an image we stored under ROOT_FOLDER + folder. */
    isOurFile(url: string, folder: UploadFolder): boolean {
      return Boolean(endpoint) && url.startsWith(`${endpoint}${ROOT_FOLDER}${folder}/`);
    },

    /** Best effort: a failed delete never fails the user's request. */
    async deleteFile(fileId: string | undefined | null): Promise<void> {
      if (!fileId || !config.IMAGEKIT_PRIVATE_KEY) return;
      try {
        const res = await fetch(`https://api.imagekit.io/v1/files/${encodeURIComponent(fileId)}`, {
          method: 'DELETE',
          headers: { authorization: `Basic ${Buffer.from(`${config.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok && res.status !== 404) console.warn(`[imagekit] delete ${fileId}: ${res.status}`);
      } catch (err) {
        console.warn('[imagekit] delete failed:', err instanceof Error ? err.message : err);
      }
    },
  };
}
export type ImageKitApi = ReturnType<typeof makeImageKit>;
