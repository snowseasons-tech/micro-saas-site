import CATALOG from '../../api/_lib/catalog.js';
import store from '../../api/_lib/store.js';
import { send, methodNotAllowed } from '../_lib/http.js';
import { useEnv, storeConfigured } from '../_lib/env.js';

export const onRequest = methodNotAllowed('GET');

// Success page polls this. "ready" comes only from the webhook-written order, not the redirect.
export async function onRequestGet({ request, env }) {
  useEnv(env);
  const id = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return send(400, { error: 'Bad session' });
  try {
    if (!storeConfigured(env)) throw new Error('Persistent store not configured');
    const order = await store.getJSON(`order:${id}`);
    if (!order) return send(200, { ready: false });
    const p = Object.prototype.hasOwnProperty.call(CATALOG, order.productId) ? CATALOG[order.productId] : null;
    if (!p) return send(410, { error: 'This product is no longer available. Contact support.' });
    return send(200, { ready: true, product: p.name, download: !!p.fileKey, appUrl: p.appUrl || null, manage: !!order.customer && !!order.subscriptionId });
  } catch (e) {
    console.error('order', e.message);
    return send(500, { error: 'Lookup failed' });
  }
}
