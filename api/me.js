const CATALOG = require('./_lib/catalog');
const auth = require('./_lib/auth');
const { send, allow } = require('./_lib/http');

// Signed-in account + the applications it is entitled to. 401 when not signed in.
module.exports = async (req, res) => {
  if (!allow(req, res, 'GET')) return;
  try {
    const user = await auth.getSession(req);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    const apps = user.products
      .filter((id) => Object.prototype.hasOwnProperty.call(CATALOG, id))
      .map((id) => {
        const p = CATALOG[id];
        return { id, name: p.name, category: p.category || null, version: p.version || null, sha256: p.sha256 || null, download: !!p.fileKey };
      });
    send(res, 200, { email: user.email, apps });
  } catch (e) {
    console.error('me', e.message);
    send(res, 500, { error: 'Could not load your workspace' });
  }
};
