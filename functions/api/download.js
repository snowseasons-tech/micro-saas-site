import CATALOG from '../../api/_lib/catalog.js';
import store from '../../api/_lib/store.js';
import { presignFromEnv } from '../../api/_lib/sigv4.js';
import { send, methodNotAllowed } from '../_lib/http.js';
import { useEnv, storeConfigured } from '../_lib/env.js';

const MAX_DOWNLOADS = 10;
const URL_TTL_SEC = 300;

export const onRequest = methodNotAllowed('GET');

// Verified purchase -> 5-minute signed URL to the private bucket. Files are never in the web root.
export async function onRequestGet({ request, env }) {
  useEnv(env);
  const id = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return send(400, { error: 'Bad session' });
  try {
    if (!storeConfigured(env)) throw new Error('Persistent store not configured');
    const order = await store.getJSON(`order:${id}`);
    if (!order) return send(403, { error: 'No verified purchase for this session' });
    const p = Object.prototype.hasOwnProperty.call(CATALOG, order.productId) ? CATALOG[order.productId] : null;
    if (!p) return send(410, { error: 'This product is no longer available. Contact support.' });
    if (!p.fileKey) return send(404, { error: 'Nothing to download for this product' });
    if (order.subscriptionId) {
      const sub = await store.getJSON(`sub:${order.subscriptionId}`);
      if (!sub || !['active', 'trialing'].includes(sub.status)) return send(403, { error: 'Subscription is not active' });
    }
    // Build the URL first and count last, so failed checks or bad config don't use up the allowance.
    const location = presignFromEnv(p.fileKey, p.filename, env, URL_TTL_SEC);
    if ((await store.incr(`dl:${id}`)) > MAX_DOWNLOADS) return send(429, { error: 'Download limit reached. Contact support.' });
    return send(302, '', { Location: location });
  } catch (e) {
    console.error('download', e.message);
    return send(500, { error: 'Download unavailable' });
  }
}
