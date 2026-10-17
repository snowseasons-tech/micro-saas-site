const auth = require('./_lib/auth');
const { send, allow } = require('./_lib/http');

module.exports = async (req, res) => {
  if (!allow(req, res, 'POST')) return;
  try {
    await auth.destroySession(req);
  } catch (e) {
    console.error('logout', e.message);
  }
  send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
};
