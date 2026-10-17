const defaultCatalog = require('./catalog');
const store = require('./store');
const mail = require('./mail');

const CHECKOUT_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
const SUB_EVENTS = new Set(['customer.subscription.updated', 'customer.subscription.deleted']);
const DAY = 60 * 60 * 24;
// A claim starts as a short lease and becomes a 90-day "done" marker only after the work succeeds. If the
// function is killed or the release fails, the lease simply expires and a later Stripe retry does the work.
const LEASE_SEC = 10 * 60;
const DONE = 'done';

// Takes the key: 'claimed', 'done' (already finished), or throws while another attempt holds the lease
// (a 500 makes Stripe retry later instead of treating the event as handled).
async function claimOnce(s, key) {
  if (await s.claim(key, LEASE_SEC)) return 'claimed';
  if ((await s.getJSON(key)) === DONE) return DONE;
  throw new Error(`${key} is being processed`);
}
const markDone = (s, key) => s.setJSON(key, DONE, 90 * DAY);

// Idempotent: each Stripe event id is processed once; failures release the claim so Stripe retries.
async function handleEvent(event, deps = {}) {
  const s = deps.store || store;
  const catalog = deps.catalog || defaultCatalog;
  const mailer = deps.mail || mail;
  if (!CHECKOUT_EVENTS.has(event.type) && !SUB_EVENTS.has(event.type)) return 'ignored';

  const claimKey = `evt:${event.id}`;
  if ((await claimOnce(s, claimKey)) === DONE) return 'duplicate';
  try {
    const result = await processEvent(event, s, catalog, mailer);
    await markDone(s, claimKey);
    return result;
  } catch (e) {
    await s.release(claimKey).catch(() => {}); // if this fails too, the lease expires on its own
    throw e;
  }
}

async function processEvent(event, s, catalog, mailer) {
  if (SUB_EVENTS.has(event.type)) return applySubscription(event, s);

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
  const mailKey = `mail:${session.id}`;
  if (email && (await claimOnce(s, mailKey)) === 'claimed') {
    try {
      mailed = await mailer.sendMail({
        to: email,
        subject: `Your ${product.name} purchase`,
        text: `Thanks for your purchase of ${product.name}.\n\nGet your download or manage your order here:\n${process.env.SITE_URL}/success?session_id=${session.id}\n\nKeep this email: the link always gives you a fresh download.\n\nSnow Seasons Tech`,
      });
    } catch (e) {
      await s.release(mailKey).catch(() => {});
      throw e;
    }
    await markDone(s, mailKey);
  }
  return `fulfilled:${mailed}`;
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
