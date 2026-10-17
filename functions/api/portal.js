import { createHash, randomBytes } from 'node:crypto';
import store from '../../api/_lib/store.js';
import mail from '../../api/_lib/mail.js';
import { stripeClient } from '../_lib/stripe.js';
import { send } from '../_lib/http.js';
import { useEnv, storeConfigured } from '../_lib/env.js';

const LINK_TTL_SEC = 30 * 60;
const RESEND_GAP_SEC = 60;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const onRequest = () => send(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });

// Stripe-hosted billing portal (cancel / update card / invoices) for a verified subscription order.
// The checkout session_id alone is not proof of ownership (it sits in emails and browser history), so
//   POST {session_id}  emails a 30-minute link to the order's address, and
//   GET  ?t=<token>    redeems that link for a Stripe portal session.
// The link is reusable within its window so email link scanners can't burn it.
export async function onRequestPost({ request, env }) {
  useEnv(env);
  try {
    let body = {};
    try { body = JSON.parse((await request.text()) || '{}'); } catch { return send(400, { error: 'Bad JSON' }); }
    const id = String(body.session_id || '');
    if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return send(400, { error: 'Bad session' });
    if (!storeConfigured(env)) throw new Error('Persistent store not configured');
    const order = await store.getJSON(`order:${id}`);
    if (!order || !order.customer || !order.subscriptionId) return send(403, { error: 'No subscription for this order' });
    if (!order.email) return send(409, { error: 'No email on this order. Contact support.' });
    if (!(await store.claim(`portalmail:${id}`, RESEND_GAP_SEC))) return send(429, { error: 'A link was just sent. Check your email.' });

    const token = randomBytes(32).toString('base64url');
    await store.setJSON(`portal:${sha256(token)}`, { customer: order.customer }, LINK_TTL_SEC);
    const sent = await mail.sendMail({
      to: order.email,
      subject: 'Manage your subscription',
      text: `Use this link within 30 minutes to manage your subscription (cancel, update card, invoices):\n${env.SITE_URL}/api/portal?t=${token}\n\nIf you didn't ask for this, you can ignore this email.\n\nSnow Seasons Tech`,
    });
    if (sent !== 'sent') {
      await store.release(`portalmail:${id}`);
      return send(503, { error: 'Email is not configured. Contact support.' });
    }
    return send(200, { sent: true });
  } catch (e) {
    console.error('portal', e.message);
    return send(500, { error: 'Could not send the billing portal link' });
  }
}

export async function onRequestGet({ request, env }) {
  useEnv(env);
  const token = new URL(request.url).searchParams.get('t') || '';
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return send(400, { error: 'Bad link' });
  try {
    if (!storeConfigured(env)) throw new Error('Persistent store not configured');
    const link = await store.getJSON(`portal:${sha256(token)}`);
    if (!link) return send(410, 'This link has expired. Request a new one from your order page.');
    const portal = await stripeClient(env).billingPortal.sessions.create({ customer: link.customer, return_url: env.SITE_URL });
    return send(302, '', { Location: portal.url });
  } catch (e) {
    console.error('portal', e.message);
    return send(500, { error: 'Could not open billing portal' });
  }
}
