const Stripe = require('stripe');
function stripeClient(env = process.env) {
  const key = env.STRIPE_SECRET_KEY || '';
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  if (key.startsWith('sk_live_') && env.ALLOW_LIVE !== '1') {
    throw new Error('Live Stripe key refused: set ALLOW_LIVE=1 only for the production deployment');
  }
  return new Stripe(key);
}
module.exports = { stripeClient };
