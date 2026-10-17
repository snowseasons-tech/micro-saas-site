const auth = require('./_lib/auth');
const { send, allow, readRaw } = require('./_lib/http');

// Customer portal sign-in. JSON body only, which (with the SameSite=Strict cookie) blocks cross-site form posts.
module.exports = async (req, res) => {
  if (!allow(req, res, 'POST')) return;
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'Expected JSON' });
  try {
    let body = {};
    try { body = JSON.parse((await readRaw(req)).toString() || '{}'); } catch { return send(res, 400, { error: 'Bad JSON' }); }
    const email = auth.normEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || email.length > 254 || !password || password.length > 256) return send(res, 400, { error: 'Email and password are required' });
    const ip = auth.clientIp(req);
    if (await auth.loginLimited(ip, email)) return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    const user = await auth.checkCredentials(email, password);
    if (!user) {
      await auth.recordLoginFailure(ip, email);
      return send(res, 401, { error: 'Incorrect email or password' });
    }
    const token = await auth.createSession(email, user);
    send(res, 200, { email }, { 'Set-Cookie': auth.sessionCookie(token) });
  } catch (e) {
    console.error('login', e.message);
    send(res, 500, { error: 'Sign-in unavailable' });
  }
};
