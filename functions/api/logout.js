import auth from '../../api/_lib/auth.js';
import { send, methodNotAllowed } from '../_lib/http.js';
import { useEnv, nodeReq } from '../_lib/env.js';

export const onRequest = methodNotAllowed('POST');

export async function onRequestPost({ request, env }) {
  useEnv(env);
  try {
    await auth.destroySession(nodeReq(request));
  } catch (e) {
    console.error('logout', e.message);
  }
  return send(200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
}
