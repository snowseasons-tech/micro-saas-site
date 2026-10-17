const test = require('node:test');
const assert = require('node:assert');
const Stripe = require('stripe');
const { presignGet } = require('../api/_lib/sigv4');
const { handleEvent } = require('../api/_lib/fulfil');
const store = require('../api/_lib/store');

test('sigv4 matches AWS documented presign example', () => {
  const url = presignGet({
    host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expires: 86400, now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'));
});

const ev = (id, paid = 'paid') => ({ id, type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_abc1234567890', payment_status: paid, metadata: { product_id: 'bookscan' }, customer_details: { email: 'a@b.co' } } } });

test('fulfilment is idempotent and records order', async () => {
  assert.strictEqual(await handleEvent(ev('evt_1')), 'fulfilled:skipped');
  assert.strictEqual(await handleEvent(ev('evt_1')), 'duplicate');
  assert.strictEqual((await store.getJSON('order:cs_test_abc1234567890')).productId, 'bookscan');
});
test('unpaid sessions are not fulfilled', async () => {
  assert.strictEqual(await handleEvent(ev('evt_2', 'unpaid')), 'unpaid');
  assert.strictEqual(await store.getJSON('order:cs_test_unpaid0000000'), null);
});
test('bad product releases claim so retry works', async () => {
  const bad = ev('evt_3'); bad.data.object.metadata.product_id = 'nope';
  await assert.rejects(handleEvent(bad));
  assert.strictEqual(await store.claim('evt:evt_3', 10), true);
});
test('webhook signature verifies on raw body only', () => {
  const stripe = new Stripe('sk_test_x');
  const payload = JSON.stringify({ id: 'evt_9', object: 'event' });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_t' });
  assert.ok(stripe.webhooks.constructEvent(Buffer.from(payload), header, 'whsec_t'));
  assert.throws(() => stripe.webhooks.constructEvent(Buffer.from(payload + ' '), header, 'whsec_t'));
});

// ---- subscriptions + email ----
const cat = { sub1: { name: 'Sub One', kind: 'subscription', priceEnv: 'X' } };
const sent = [];
const deps = { catalog: cat, mail: { sendMail: async (m) => (sent.push(m), 'sent') } };
const subSession = (id) => ({ id, type: 'checkout.session.completed', created: 100,
  data: { object: { id: 'cs_test_sub0000000001', mode: 'subscription', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1',
    metadata: { product_id: 'sub1' }, customer_details: { email: 'buyer@x.co' } } } });
const subEvt = (id, type, status, created) => ({ id, type, created,
  data: { object: { id: 'sub_1', customer: 'cus_1', status, cancel_at_period_end: false, metadata: { product_id: 'sub1' }, items: { data: [{ current_period_end: 999 }] } } } });

test('subscription checkout records order+sub and emails once', async () => {
  assert.strictEqual(await handleEvent(subSession('evt_s1'), deps), 'fulfilled:sent');
  assert.strictEqual((await store.getJSON('sub:sub_1')).status, 'active');
  assert.strictEqual((await store.getJSON('order:cs_test_sub0000000001')).subscriptionId, 'sub_1');
  // different event id, same order (e.g. async success later): no second email
  assert.strictEqual(await handleEvent(subSession('evt_s1b'), deps), 'fulfilled:no-email');
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /success\?session_id=cs_test_sub0000000001/);
});
test('subscription updates apply, stale ones are ignored, delete cancels', async () => {
  assert.strictEqual(await handleEvent(subEvt('evt_u1', 'customer.subscription.updated', 'past_due', 200), deps), 'subscription-updated');
  assert.strictEqual((await store.getJSON('sub:sub_1')).status, 'past_due');
  assert.strictEqual(await handleEvent(subEvt('evt_u0', 'customer.subscription.updated', 'active', 150), deps), 'stale');
  assert.strictEqual((await store.getJSON('sub:sub_1')).status, 'past_due');
  await handleEvent(subEvt('evt_d1', 'customer.subscription.deleted', 'canceled', 300), deps);
  assert.strictEqual((await store.getJSON('sub:sub_1')).status, 'canceled');
  assert.strictEqual((await store.getJSON('sub:sub_1')).currentPeriodEnd, 999);
});
test('mail failure releases claims so Stripe retry re-sends', async () => {
  const bad = { catalog: cat, mail: { sendMail: async () => { throw new Error('boom'); } } };
  const e = subSession('evt_m1'); e.data.object.id = 'cs_test_mailfail00001';
  await assert.rejects(handleEvent(e, bad));
  assert.strictEqual(await handleEvent(e, deps), 'fulfilled:sent');
});
test('mail module skips without config', async () => {
  assert.strictEqual(await require('../api/_lib/mail').sendMail({ to: 'a@b.co', subject: 's', text: 't' }, {}), 'skipped');
});

test('presigned PUT signs the PUT method for the configured bucket', () => {
  const { presignPutFromEnv, presignFromEnv } = require('../api/_lib/sigv4');
  const env = { S3_ENDPOINT: 'https://r2.example.com', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' };
  const put = presignPutFromEnv('bookscan-live/bookscan-live.html', env);
  assert.match(put, /^https:\/\/r2\.example\.com\/b\/bookscan-live\/bookscan-live\.html\?/);
  const sig = (u) => new URL(u).searchParams.get('X-Amz-Signature');
  assert.notStrictEqual(sig(put), sig(presignFromEnv('bookscan-live/bookscan-live.html', 'x.html', env)));
});

test('a stuck lease makes Stripe retry instead of being treated as handled, then expires', async () => {
  const e = ev('evt_lease1'); e.data.object.id = 'cs_test_lease00000001';
  await store.claim('evt:evt_lease1', 1); // simulate an invocation killed mid-handling
  await assert.rejects(handleEvent(e), /being processed/);
  await new Promise((r) => setTimeout(r, 1100));
  assert.strictEqual(await handleEvent(e), 'fulfilled:skipped');
  assert.strictEqual(await handleEvent(e), 'duplicate');
});
test('a failed release does not block the retry for long', async () => {
  const flaky = { ...store, setJSON: async () => { throw new Error('store down'); }, release: async () => { throw new Error('store down'); } };
  const e = ev('evt_flaky1'); e.data.object.id = 'cs_test_flaky00000001';
  await assert.rejects(handleEvent(e, { store: flaky }), /store down/);
  await assert.rejects(handleEvent(e), /being processed/); // lease still held, so Stripe gets a 500 and retries
});
