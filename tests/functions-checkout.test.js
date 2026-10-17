const test = require('node:test');
const assert = require('node:assert');

const post = (body) => new Request('https://x.test/api/checkout', { method: 'POST', body });
const load = () => import('../functions/api/checkout.js');

test('checkout function rejects non-POST', async () => {
  const { onRequest } = await load();
  const res = onRequest({ request: new Request('https://x.test/api/checkout') });
  assert.strictEqual(res.status, 405);
  assert.strictEqual(res.headers.get('Allow'), 'POST');
});
test('checkout function validates the request', async () => {
  const { onRequestPost } = await load();
  assert.strictEqual((await onRequestPost({ request: post('{nope'), env: {} })).status, 400);
  assert.strictEqual((await onRequestPost({ request: post('{"productId":"__proto__"}'), env: {} })).status, 400);
  assert.strictEqual((await onRequestPost({ request: post('{"productId":"bookscan"}'), env: {} })).status, 503);
});
test('checkout function creates a session through Stripe', async () => {
  const { onRequestPost } = await load();
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: String(init.body) };
    return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/c/1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const env = { STRIPE_SECRET_KEY: 'sk_test_123', PRICE_BOOKSCAN: 'price_123', SITE_URL: 'https://site.test' };
    const res = await onRequestPost({ request: post('{"productId":"bookscan"}'), env });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { url: 'https://checkout.stripe.test/c/1' });
    assert.match(sent.url, /checkout\/sessions$/);
    assert.match(sent.body, /price_123/);
  } finally { globalThis.fetch = realFetch; }
});
test('checkout function refuses a live key without ALLOW_LIVE', async () => {
  const { onRequestPost } = await load();
  const env = { STRIPE_SECRET_KEY: 'sk_live_123', PRICE_BOOKSCAN: 'price_123', SITE_URL: 'https://site.test' };
  assert.strictEqual((await onRequestPost({ request: post('{"productId":"bookscan"}'), env })).status, 500);
});
