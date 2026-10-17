const CATALOG = require('./_lib/catalog');
const auth = require('./_lib/auth');
const { presignFromEnv } = require('./_lib/sigv4');
const { send, allow } = require('./_lib/http');

const URL_TTL_SEC = 120;

// Portal download: signed-in account + entitlement -> 2-minute signed URL to the private bucket.
module.exports = async (req, res) => {
  if (!allow(req, res, 'GET')) return;
  const id = new URL(req.url, 'http://x').searchParams.get('product') || '';
  if (!Object.prototype.hasOwnProperty.call(CATALOG, id)) return send(res, 404, { error: 'Unknown application' });
  try {
    const user = await auth.getSession(req);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    if (!user.products.includes(id)) return send(res, 403, { error: 'Your account does not include this application' });
    const p = CATALOG[id];
    if (!p.fileKey) return send(res, 404, { error: 'Nothing to download for this application' });
    send(res, 302, '', { Location: presignFromEnv(p.fileKey, p.filename, process.env, URL_TTL_SEC) });
  } catch (e) {
    console.error('app-download', e.message);
    send(res, 500, { error: 'Download unavailable' });
  }
};
