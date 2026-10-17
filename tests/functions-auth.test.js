const test = require('node:test');
const assert = require('node:assert');
const fakeUpstash = require('./fake-upstash');

const env = { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't' };
const req = (path, { method = 'GET', body, cookie, type = 'application/json', ip = '203.0.113.9' } = {}) => new Request(`https://x.test${path}`, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(type ? { 'Content-Type': type } : {}), ...(cookie ? { Cookie: cookie } : {}), 'CF-Connecting-IP': ip },
});
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

test('login -> me -> logout through Pages Functions', async () => {
  const [{ onRequestPost: login }, { onRequestGet: me }, { onRequestPost: logout }] = await Promise.all([
    import('../functions/api/login.js'), import('../functions/api/me.js'), import('../functions/api/logout.js')]);
  const auth = require('../api/_lib/auth');
  const store = require('../api/_lib/store');
  const up = fakeUpstash();
  Object.assign(process.env, env);
  try {
    await store.setJSON('user:pat@example.com', { hash: await auth.hashPassword('s3cret-password'), products: ['bookscan'] });

    assert.strictEqual((await me({ request: req('/api/me'), env })).status, 401);
    assert.strictEqual((await login({ request: req('/api/login', { method: 'POST', body: { email: 'Pat@Example.com', password: 'nope' } }), env })).status, 401);
    assert.strictEqual((await login({ request: req('/api/login', { method: 'POST', body: {}, type: 'text/plain' }), env })).status, 415);

    const ok = await login({ request: req('/api/login', { method: 'POST', body: { email: 'Pat@Example.com', password: 's3cret-password' } }), env });
    assert.strictEqual(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /Path=\/api; HttpOnly; Secure; SameSite=Strict/);
    const cookie = cookieOf(ok);

    const ws = await (await me({ request: req('/api/me', { cookie }), env })).json();
    assert.strictEqual(ws.email, 'pat@example.com');
    assert.deepStrictEqual(ws.apps.map((a) => a.id), ['bookscan']);

    const out = await logout({ request: req('/api/logout', { method: 'POST', cookie }), env });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.strictEqual((await me({ request: req('/api/me', { cookie }), env })).status, 401);
  } finally { up.restore(); }
});
test('login is rate limited per ip and email after repeated failures', async () => {
  const { onRequestPost: login } = await import('../functions/api/login.js');
  const up = fakeUpstash();
  try {
    const attempt = () => login({ request: req('/api/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'x' }, ip: '198.51.100.7' }), env });
    for (let i = 0; i < 8; i++) assert.strictEqual((await attempt()).status, 401);
    assert.strictEqual((await attempt()).status, 429);
  } finally { up.restore(); }
});
test('me and login fail closed (500) without a persistent store', async () => {
  const { onRequestGet: me } = await import('../functions/api/me.js');
  const { onRequestPost: login } = await import('../functions/api/login.js');
  assert.strictEqual((await me({ request: req('/api/me'), env: {} })).status, 500);
  assert.strictEqual((await login({ request: req('/api/login', { method: 'POST', body: { email: 'a@b.co', password: 'x' } }), env: {} })).status, 500);
});
