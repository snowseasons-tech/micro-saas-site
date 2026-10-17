const defaultCatalog = require('./catalog');
const store = require('./store');
const mail = require('./mail');

const CHECKOUT_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
const SUB_EVENTS = new Set(['customer.subscription.updated', 'customer.subscription.deleted']);
const DAY = 60 * 60 * 24;

// Idempotent: each Stripe event id is processed once; failures release the claim so Stripe retries.
async function handleEvent(event, deps = {}) {
  const s = deps.store || store;
  const catalog = deps.catalog || defaultCatalog;
  const mailer = deps.mail || mail;
  if (!CHECKOUT_EVENTS.has(event.type) && !SUB_EVENTS.has(event.type)) return 'ignored';

  const claimKey = `evt:${event.id}`;
  if (!(await s.claim(claimKey, 90 * DAY))) return 'duplicate';
  try {
    if (SUB_EVENTS.has(event.type)) return await applySubscription(event, s);

    const session = event.data.object;
    // 'no_payment_required' covers free trials on subscriptions; async methods wait for async_payment_succeeded.
    if (!['paid', 'no_payment_required'].includes(session.payment_status)) return 'unpaid';
    const productId = session.metadata && session.metadata.product_id;
    const product = Object.prototype.hasOwnProperty.call(catalog, productId) ? catalog[productId] : null;
    if (!product) throw new Error(`unknown product ${productId}`);

    const email = (session.customer_details && session.customer_details.email) || null;
    await s.setJSON(`order:${session.id}`, {
      productId, email, paidAt: Date.now(),
      customer: session.customer || null,
      subscriptionId: session.subscription || null,
    });
    if (session.subscription) {
      const existing = await s.getJSON(`sub:${session.subscription}`);
      await s.setJSON(`sub:${session.subscription}`, { status: 'active', productId, email, customer: session.customer || null, ...(existing || {}) });
    }

    // Email the order page link (it mints a fresh 5-minute download URL each visit). Sent once per order.
    let mailed = 'no-email';
    if (email && (await s.claim(`mail:${session.id}`, 90 * DAY))) {
      try {
        mailed = await mailer.sendMail({
          to: email,
          subject: `Your ${product.name} purchase`,
          text: `Thanks for your purchase of ${product.name}.\n\nGet your download or manage your order here:\n${process.env.SITE_URL}/success?session_id=${session.id}\n\nKeep this email: the link always gives you a fresh download.\n\nSnow Seasons Tech`,
        });
      } catch (e) {
        await s.release(`mail:${session.id}`);
        throw e;
      }
    }
    return `fulfilled:${mailed}`;
  } catch (e) {
    await s.release(claimKey);
    throw e;
  }
}

// Keeps subscription status current; ignores events older than the last one applied.
async function applySubscription(event, s) {
  const sub = event.data.object;
  const existing = await s.getJSON(`sub:${sub.id}`);
  if (existing && existing.lastEventAt && existing.lastEventAt > event.created) return 'stale';
  const item = sub.items && sub.items.data && sub.items.data[0];
  await s.setJSON(`sub:${sub.id}`, {
    ...(existing || {}),
    productId: (existing && existing.productId) || (sub.metadata && sub.metadata.product_id) || null,
    customer: sub.customer,
    status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: (item && item.current_period_end) || sub.current_period_end || null,
    lastEventAt: event.created,
  });
  return 'subscription-updated';
}
module.exports = { handleEvent };
