const test = require('node:test');
const assert = require('node:assert');
const fakeUpstash = require('./fake-upstash');
const store = require('../api/_lib/store');
const auth = require('../api/_lib/auth');

const env = {
  UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't', SITE_URL: 'https://site.test',
  STRIPE_SECRET_KEY: 'sk_test_123', PRICE_BOOKSCAN: 'price_123', RESEND_API_KEY: 're_1', MAIL_FROM: 'a@site.test',
  S3_ENDPOINT: 'https://r2.example.com', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
};
Object.assign(process.env, env);
const get = (path, headers) => ({ request: new Request(`https://x.test${path}`, { headers }), env });
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const mod = (n) => import(`../functions/api/${n}.js`);

test('order reports readiness from the webhook-written order only', async () => {
  const { onRequestGet } = await mod('order');
  const up = fakeUpstash();
  try {
    assert.strictEqual((await onRequestGet(get('/api/order?session_id=bad'))).status, 400);
    assert.deepStrictEqual(await (await onRequestGet(get('/api/order?session_id=cs_test_ord0000000001'))).json(), { ready: false });
    await store.setJSON('order:cs_test_ord0000000001', { productId: 'bookscan', customer: 'cus_1', subscriptionId: 'sub_1' });
    const res = await (await onRequestGet(get('/api/order?session_id=cs_test_ord0000000001'))).json();
    assert.deepStrictEqual([res.ready, res.product, res.download, res.manage], [true, 'BookScan Live', true, true]);
  } finally { up.restore(); }
});

test('download signs a URL, counts downloads, and enforces the limit', async () => {
  const { onRequestGet } = await mod('download');
  const up = fakeUpstash();
  const url = '/api/download?session_id=cs_test_dl00000000001';
  try {
    assert.strictEqual((await onRequestGet(get(url))).status, 403);
    await store.setJSON('order:cs_test_dl00000000001', { productId: 'bookscan' });
    const ok = await onRequestGet(get(url));
    assert.strictEqual(ok.status, 302);
    assert.match(ok.headers.get('location'), /^https:\/\/r2\.example\.com\/b\/bookscan-live\/bookscan-live\.html\?.*X-Amz-Expires=300.*X-Amz-Signature=/);
    for (let i = 1; i < 10; i++) assert.strictEqual((await onRequestGet(get(url))).status, 302);
    assert.strictEqual((await onRequestGet(get(url))).status, 429);
  } finally { up.restore(); }
});
test('download requires an active subscription for subscription orders', async () => {
  const { onRequestGet } = await mod('download');
  const up = fakeUpstash();
  try {
    await store.setJSON('order:cs_test_dl00000000002', { productId: 'bookscan', subscriptionId: 'sub_9' });
    assert.strictEqual((await onRequestGet(get('/api/download?session_id=cs_test_dl00000000002'))).status, 403);
    await store.setJSON('sub:sub_9', { status: 'active' });
    assert.strictEqual((await onRequestGet(get('/api/download?session_id=cs_test_dl00000000002'))).status, 302);
  } finally { up.restore(); }
});

test('app-download needs a session and entitlement', async () => {
  const { onRequestGet } = await mod('app-download');
  const up = fakeUpstash();
  try {
    const user = { hash: await auth.hashPassword('s3cret-password'), products: ['bookscan'] };
    await store.setJSON('user:pat@example.com', user);
    const cookie = `ss_session=${await auth.createSession('pat@example.com', user)}`;
    assert.strictEqual((await onRequestGet(get('/api/app-download?product=__proto__', { cookie }))).status, 404);
    assert.strictEqual((await onRequestGet(get('/api/app-download?product=bookscan'))).status, 401);
    const ok = await onRequestGet(get('/api/app-download?product=bookscan', { cookie }));
    assert.strictEqual(ok.status, 302);
    assert.match(ok.headers.get('location'), /X-Amz-Expires=120/);
    await store.setJSON('user:pat@example.com', { ...user, products: [] });
    assert.strictEqual((await onRequestGet(get('/api/app-download?product=bookscan', { cookie }))).status, 403);
  } finally { up.restore(); }
});

test('products reads display prices from Stripe', async () => {
  const { onRequestGet } = await mod('products');
  const up = fakeUpstash((url) => {
    assert.match(url, /api\.stripe\.com\/v1\/prices\/price_123$/);
    return json({ id: 'price_123', unit_amount: 1900, currency: 'usd', recurring: null });
  });
  try {
    const res = await onRequestGet({ env });
    assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=60');
    const { products } = await res.json();
    assert.deepStrictEqual([products[0].id, products[0].amount, products[0].currency, products[0].interval], ['bookscan', 1900, 'usd', null]);
  } finally { up.restore(); }
});

test('portal emails a link, then redeems it for a Stripe billing portal session', async () => {
  const { onRequestPost, onRequestGet } = await mod('portal');
  let mailed; let portalBody;
  const up = fakeUpstash((url, init) => {
    if (url === 'https://api.resend.com/emails') { mailed = JSON.parse(init.body); return json({ id: 'em_1' }); }
    if (url === 'https://api.stripe.com/v1/billing_portal/sessions') { portalBody = String(init.body); return json({ id: 'bps_1', url: 'https://billing.stripe.test/p/1' }); }
    throw new Error(`unexpected fetch ${url}`);
  });
  const post = (body) => onRequestPost({ request: new Request('https://x.test/api/portal', { method: 'POST', body: JSON.stringify(body) }), env });
  try {
    assert.strictEqual((await post({ session_id: 'nope' })).status, 400);
    assert.strictEqual((await post({ session_id: 'cs_test_pt00000000001' })).status, 403);
    await store.setJSON('order:cs_test_pt00000000001', { productId: 'bookscan', customer: 'cus_7', subscriptionId: 'sub_7', email: 'pat@example.com' });
    assert.strictEqual((await post({ session_id: 'cs_test_pt00000000001' })).status, 200);
    assert.deepStrictEqual(mailed.to, ['pat@example.com']);
    assert.strictEqual((await post({ session_id: 'cs_test_pt00000000001' })).status, 429);

    const token = mailed.text.match(/\/api\/portal\?t=([\w-]+)/)[1];
    const open = await onRequestGet(get(`/api/portal?t=${token}`));
    assert.strictEqual(open.status, 302);
    assert.strictEqual(open.headers.get('location'), 'https://billing.stripe.test/p/1');
    assert.match(portalBody, /customer=cus_7/);
    assert.strictEqual((await onRequestGet(get(`/api/portal?t=${'a'.repeat(43)}`))).status, 410);
    assert.strictEqual((await onRequestGet(get('/api/portal?t=short'))).status, 400);
  } finally { up.restore(); }
});
test('portal answers other methods with 405 and its Allow list', async () => {
  const { onRequest } = await mod('portal');
  const res = onRequest();
  assert.deepStrictEqual([res.status, res.headers.get('allow')], [405, 'GET, POST']);
});
