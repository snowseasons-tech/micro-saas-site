import { presign } from '../_lib/presign.js';
import { send, methodNotAllowed } from '../_lib/http.js';

// GET /blog-img/<key>: redirects to a presigned R2 URL that expires after BLOG_IMAGE_TTL seconds (default 3600).
// Blog images live in a private bucket, so the only working links to them are short-lived ones handed out here.
// Only keys the mariadb-auto-blogger skill creates are signed, so this can't be used to read anything else.
const KEY_RE = /^blog\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-f0-9]{16}\.(?:jpg|png|webp|gif)$/;

export const onRequest = methodNotAllowed('GET');

export async function onRequestGet({ params, env }) {
  const key = [].concat(params.path || []).join('/');
  if (!KEY_RE.test(key)) return send(404, 'Not found');
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((k) => !env[k]);
  if (missing.length) return send(503, 'Image hosting is not set up');
  const expires = Math.min(Math.max(Number(env.BLOG_IMAGE_TTL) || 3600, 60), 604800);
  const url = await presign({
    host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${env.R2_BUCKET}/${key}`,
    accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY, expires,
  });
  // The browser may reuse this redirect only while the signed URL is still well within its lifetime
  return send(302, '', { Location: url, 'Cache-Control': `private, max-age=${Math.floor(expires / 2)}` });
}
