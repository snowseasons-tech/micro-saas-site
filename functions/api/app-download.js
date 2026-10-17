import CATALOG from '../../api/_lib/catalog.js';
import auth from '../../api/_lib/auth.js';
import { presignFromEnv } from '../../api/_lib/sigv4.js';
import { send, methodNotAllowed } from '../_lib/http.js';
import { useEnv, nodeReq, storeConfigured } from '../_lib/env.js';

const URL_TTL_SEC = 120;

export const onRequest = methodNotAllowed('GET');

// Portal download: signed-in account + entitlement -> 2-minute signed URL to the private bucket.
export async function onRequestGet({ request, env }) {
  useEnv(env);
  const id = new URL(request.url).searchParams.get('product') || '';
  if (!Object.prototype.hasOwnProperty.call(CATALOG, id)) return send(404, { error: 'Unknown application' });
  try {
    if (!storeConfigured(env)) throw new Error('Persistent store not configured');
    const user = await auth.getSession(nodeReq(request));
    if (!user) return send(401, { error: 'Not signed in' });
    if (!user.products.includes(id)) return send(403, { error: 'Your account does not include this application' });
    const p = CATALOG[id];
    if (!p.fileKey) return send(404, { error: 'Nothing to download for this application' });
    return send(302, '', { Location: presignFromEnv(p.fileKey, p.filename, env, URL_TTL_SEC) });
  } catch (e) {
    console.error('app-download', e.message);
    return send(500, { error: 'Download unavailable' });
  }
}
