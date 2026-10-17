const store = require('./_lib/store');
const { stripeClient } = require('./_lib/stripe');
const { send, allow, readRaw } = require('./_lib/http');

// Stripe-hosted billing portal (cancel / update card / invoices) for a verified subscription order.
// Configure the portal in the Stripe dashboard (test mode first) before use.
module.exports = async (req, res) => {
  if (!allow(req, res, 'POST')) return;
  try {
    let body = {};
    try { body = JSON.parse((await readRaw(req)).toString() || '{}'); } catch { return send(res, 400, { error: 'Bad JSON' }); }
    const id = String(body.session_id || '');
    if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return send(res, 400, { error: 'Bad session' });
    const order = await store.getJSON(`order:${id}`);
    if (!order || !order.customer) return send(res, 403, { error: 'No subscription for this order' });
    const portal = await stripeClient().billingPortal.sessions.create({ customer: order.customer, return_url: process.env.SITE_URL });
    send(res, 200, { url: portal.url });
  } catch (e) {
    console.error('portal', e.message);
    send(res, 500, { error: 'Could not open billing portal' });
  }
};
