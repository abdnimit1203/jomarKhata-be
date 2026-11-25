/**
 * Live check of the ImageKit setup (no SDK): signs params the way /uploads/imagekit-auth does,
 * uploads a 1x1 PNG to /jomarkhata/test, then deletes it. Run: npx tsx scripts/test-imagekit.ts
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { makeImageKit, ROOT_FOLDER } from '../src/lib/imagekit.js';

const ik = makeImageKit(loadConfig());
if (!ik.enabled) throw new Error('IMAGEKIT_* env missing');
const a = ik.authParams();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const form = new FormData();
form.append('file', new Blob([png], { type: 'image/png' }), 'check.png');
form.append('fileName', 'check.png');
form.append('publicKey', a.publicKey);
form.append('signature', a.signature);
form.append('expire', String(a.expire));
form.append('token', a.token);
form.append('folder', `${ROOT_FOLDER}/test`);
form.append('useUniqueFileName', 'true');
const res = await fetch('https://upload.imagekit.io/api/v1/files/upload', { method: 'POST', body: form });
const data = (await res.json()) as { url?: string; fileId?: string; message?: string };
console.log('isOurFile:', data.url ? ik.isOurFile(data.url.replace('/test/', '/avatars/'), '/avatars') : '-');
console.log('upload:', res.status, data.url ? 'ok' : data.message, data.url?.includes(`${ROOT_FOLDER}/test/`) ? '(right folder)' : '');
if (data.fileId) {
  await ik.deleteFile(data.fileId);
  const gone = await fetch(`https://api.imagekit.io/v1/files/${data.fileId}/details`, {
    headers: { authorization: `Basic ${Buffer.from(`${process.env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')}` },
  });
  console.log('deleted:', gone.status === 404 ? 'yes' : `no (${gone.status})`);
}
