import CATALOG from '../../api/_lib/catalog.js';
import { stripeClient } from '../_lib/stripe.js';
import { send, methodNotAllowed } from '../_lib/http.js';

export const onRequest = methodNotAllowed('POST');

export async function onRequestPost({ request, env }) {
  try {
    let body = {};
    try { body = JSON.parse((await request.text()) || '{}'); } catch { return send(400, { error: 'Bad JSON' }); }
    const product = Object.prototype.hasOwnProperty.call(CATALOG, body.productId) ? CATALOG[body.productId] : null;
    if (!product) return send(400, { error: 'Unknown product' });
    const price = env[product.priceEnv];
    const site = env.SITE_URL;
    if (!price || !site) return send(503, { error: 'Checkout not configured' });

    const isSub = product.kind === 'subscription';
    const session = await stripeClient(env).checkout.sessions.create({
      mode: isSub ? 'subscription' : 'payment',
      line_items: [{ price, quantity: 1 }],
      metadata: { product_id: body.productId },
      success_url: `${site}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/cancel`,
      automatic_tax: { enabled: env.STRIPE_AUTOMATIC_TAX === 'true' },
      allow_promotion_codes: true,
      ...(isSub ? { subscription_data: { metadata: { product_id: body.productId } } } : {}),
    });
    return send(200, { url: session.url });
  } catch (e) {
    console.error('checkout', e.message);
    return send(500, { error: 'Could not start checkout' });
  }
}
