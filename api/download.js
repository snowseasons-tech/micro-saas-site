const CATALOG = require('./_lib/catalog');
const store = require('./_lib/store');
const { presignFromEnv } = require('./_lib/sigv4');
const { send, allow } = require('./_lib/http');

const MAX_DOWNLOADS = 10;
const URL_TTL_SEC = 300;

// Verified purchase -> 5-minute signed URL to the private bucket. Files are never in the web root.
module.exports = async (req, res) => {
  if (!allow(req, res, 'GET')) return;
  const id = new URL(req.url, 'http://x').searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return send(res, 400, { error: 'Bad session' });
  try {
    const order = await store.getJSON(`order:${id}`);
    if (!order) return send(res, 403, { error: 'No verified purchase for this session' });
    const p = Object.prototype.hasOwnProperty.call(CATALOG, order.productId) ? CATALOG[order.productId] : null;
    if (!p) return send(res, 410, { error: 'This product is no longer available. Contact support.' });
    if (!p.fileKey) return send(res, 404, { error: 'Nothing to download for this product' });
    if (order.subscriptionId) {
      const sub = await store.getJSON(`sub:${order.subscriptionId}`);
      if (!sub || !['active', 'trialing'].includes(sub.status)) return send(res, 403, { error: 'Subscription is not active' });
    }
    // Build the URL first and count last, so failed checks or bad config don't use up the allowance.
    const location = presignFromEnv(p.fileKey, p.filename, process.env, URL_TTL_SEC);
    if ((await store.incr(`dl:${id}`)) > MAX_DOWNLOADS) return send(res, 429, { error: 'Download limit reached. Contact support.' });
    send(res, 302, '', { Location: location });
  } catch (e) {
    console.error('download', e.message);
    send(res, 500, { error: 'Download unavailable' });
  }
};
