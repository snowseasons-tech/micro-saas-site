import Stripe from 'stripe';
import { stripeClient } from '../_lib/stripe.js';
import { send, methodNotAllowed } from '../_lib/http.js';
import { useEnv, storeConfigured } from '../_lib/env.js';
import { handleEvent } from '../../api/_lib/fulfil.js';

export const onRequest = methodNotAllowed('POST');

// The signature covers the exact bytes Stripe sent, so read the body as text and never re-serialize it.
export async function onRequestPost({ request, env }) {
  useEnv(env);
  let event;
  try {
    const raw = await request.text();
    event = await stripeClient(env).webhooks.constructEventAsync(
      raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
  } catch {
    return send(400, 'Invalid signature');
  }
  if (!storeConfigured(env)) {
    console.error('webhook', event.id, 'persistent store not configured');
    return send(503, 'Store not configured'); // Stripe retries
  }
  try {
    const result = await handleEvent(event);
    return send(200, { received: true, result });
  } catch (e) {
    console.error('webhook', event.id, e.message);
    return send(500, 'Handler error'); // Stripe retries
  }
}
