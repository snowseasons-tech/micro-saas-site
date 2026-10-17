const { stripeClient } = require('./_lib/stripe');
const { send, allow, readRaw } = require('./_lib/http');
const { handleEvent } = require('./_lib/fulfil');

// Raw body is required for signature verification: body parsing must stay off.
module.exports = async (req, res) => {
  if (!allow(req, res, 'POST')) return;
  let event;
  try {
    const raw = await readRaw(req);
    event = stripeClient().webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return send(res, 400, 'Invalid signature');
  }
  try {
    const result = await handleEvent(event);
    send(res, 200, { received: true, result });
  } catch (e) {
    console.error('webhook', event.id, e.message);
    send(res, 500, 'Handler error'); // Stripe retries
  }
};
module.exports.config = { api: { bodyParser: false } };
