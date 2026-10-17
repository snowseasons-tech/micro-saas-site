import auth from '../../api/_lib/auth.js';
import { send, methodNotAllowed, clientIp } from '../_lib/http.js';
import { useEnv, storeConfigured } from '../_lib/env.js';

export const onRequest = methodNotAllowed('POST');

// Customer portal sign-in. JSON body only, which (with the SameSite=Strict cookie) blocks cross-site form posts.
export async function onRequestPost({ request, env }) {
  useEnv(env);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return send(415, { error: 'Expected JSON' });
  try {
    let body = {};
    try { body = JSON.parse((await request.text()) || '{}'); } catch { return send(400, { error: 'Bad JSON' }); }
    const email = auth.normEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || email.length > 254 || !password || password.length > 256) return send(400, { error: 'Email and password are required' });
    if (!storeConfigured(env)) throw new Error('Persistent store not configured');
    const ip = clientIp(request);
    if (await auth.loginLimited(ip, email)) return send(429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    const user = await auth.checkCredentials(email, password);
    if (!user) {
      await auth.recordLoginFailure(ip, email);
      return send(401, { error: 'Incorrect email or password' });
    }
    const token = await auth.createSession(email, user);
    return send(200, { email }, { 'Set-Cookie': auth.sessionCookie(token) });
  } catch (e) {
    console.error('login', e.message);
    return send(500, { error: 'Sign-in unavailable' });
  }
}
