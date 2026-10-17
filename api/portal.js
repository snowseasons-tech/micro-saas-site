const crypto = require('crypto');
const store = require('./_lib/store');
const mail = require('./_lib/mail');
const { stripeClient } = require('./_lib/stripe');
const { send, readRaw } = require('./_lib/http');

const LINK_TTL_SEC = 30 * 60;
const RESEND_GAP_SEC = 60;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Stripe-hosted billing portal (cancel / update card / invoices) for a verified subscription order.
// Configure the portal in the Stripe dashboard (test mode first) before use.
// The checkout session_id alone is not proof of ownership (it sits in emails and browser history), so
//   POST {session_id}  emails a 30-minute link to the order's address, and
//   GET  ?t=<token>    redeems that link for a Stripe portal session.
// The link is reusable within its window so email link scanners can't burn it.
module.exports = async (req, res) => {
  if (req.method === 'POST') return requestLink(req, res);
  if (req.method === 'GET') return openPortal(req, res);
  send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
};

async function requestLink(req, res) {
  try {
    let body = {};
    try { body = JSON.parse((await readRaw(req)).toString() || '{}'); } catch { return send(res, 400, { error: 'Bad JSON' }); }
    const id = String(body.session_id || '');
    if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return send(res, 400, { error: 'Bad session' });
    const order = await store.getJSON(`order:${id}`);
    if (!order || !order.customer || !order.subscriptionId) return send(res, 403, { error: 'No subscription for this order' });
    if (!order.email) return send(res, 409, { error: 'No email on this order. Contact support.' });
    if (!(await store.claim(`portalmail:${id}`, RESEND_GAP_SEC))) return send(res, 429, { error: 'A link was just sent. Check your email.' });

    const token = crypto.randomBytes(32).toString('base64url');
    await store.setJSON(`portal:${sha256(token)}`, { customer: order.customer }, LINK_TTL_SEC);
    const sent = await mail.sendMail({
      to: order.email,
      subject: 'Manage your subscription',
      text: `Use this link within 30 minutes to manage your subscription (cancel, update card, invoices):\n${process.env.SITE_URL}/api/portal?t=${token}\n\nIf you didn't ask for this, you can ignore this email.\n\nSnow Seasons Tech`,
    });
    if (sent !== 'sent') {
      await store.release(`portalmail:${id}`);
      return send(res, 503, { error: 'Email is not configured. Contact support.' });
    }
    send(res, 200, { sent: true });
  } catch (e) {
    console.error('portal', e.message);
    send(res, 500, { error: 'Could not send the billing portal link' });
  }
}

async function openPortal(req, res) {
  const token = new URL(req.url, 'http://x').searchParams.get('t') || '';
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return send(res, 400, { error: 'Bad link' });
  try {
    const link = await store.getJSON(`portal:${sha256(token)}`);
    if (!link) return send(res, 410, 'This link has expired. Request a new one from your order page.');
    const portal = await stripeClient().billingPortal.sessions.create({ customer: link.customer, return_url: process.env.SITE_URL });
    send(res, 302, '', { Location: portal.url });
  } catch (e) {
    console.error('portal', e.message);
    send(res, 500, { error: 'Could not open billing portal' });
  }
}
