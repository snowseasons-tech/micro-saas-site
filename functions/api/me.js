import CATALOG from '../../api/_lib/catalog.js';
import auth from '../../api/_lib/auth.js';
import { send, methodNotAllowed } from '../_lib/http.js';
import { useEnv, nodeReq, storeConfigured } from '../_lib/env.js';

export const onRequest = methodNotAllowed('GET');

// Signed-in account + the applications it is entitled to. 401 when not signed in.
export async function onRequestGet({ request, env }) {
  useEnv(env);
  try {
    if (!storeConfigured(env)) throw new Error('Persistent store not configured');
    const user = await auth.getSession(nodeReq(request));
    if (!user) return send(401, { error: 'Not signed in' });
    const apps = user.products
      .filter((id) => Object.prototype.hasOwnProperty.call(CATALOG, id))
      .map((id) => {
        const p = CATALOG[id];
        return { id, name: p.name, category: p.category || null, version: p.version || null, sha256: p.sha256 || null, download: !!p.fileKey };
      });
    return send(200, { email: user.email, apps });
  } catch (e) {
    console.error('me', e.message);
    return send(500, { error: 'Could not load your workspace' });
  }
}
