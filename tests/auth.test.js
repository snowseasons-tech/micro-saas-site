const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const store = require('../api/_lib/store');
const auth = require('../api/_lib/auth');
const login = require('../api/login');
const logout = require('../api/logout');
const me = require('../api/me');
const appDownload = require('../api/app-download');

Object.assign(process.env, { S3_ENDPOINT: 'https://r2.example.com', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' });

// Minimal Vercel-style req/res pair for calling a handler directly.
async function call(handler, { method = 'GET', url = '/', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '10.0.0.1' } });
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await handler(req, res);
  res.json = res.body ? (() => { try { return JSON.parse(res.body); } catch { return null; } })() : null;
  return res;
}
const cookieOf = (res) => res.headers['set-cookie'].split(';')[0];

test('password hashes verify and reject wrong passwords', async () => {
  const h = await auth.hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.strictEqual(await auth.verifyPassword('correct horse battery', h), true);
  assert.strictEqual(await auth.verifyPassword('wrong', h), false);
});

test('login -> me -> download -> logout', async () => {
  await store.setJSON('user:pat@example.com', { hash: await auth.hashPassword('s3cret-password'), products: ['bookscan'] });

  assert.strictEqual((await call(me)).statusCode, 401);
  assert.strictEqual((await call(login, { method: 'POST', body: { email: 'Pat@Example.com', password: 'nope' } })).statusCode, 401);

  const ok = await call(login, { method: 'POST', body: { email: 'Pat@Example.com', password: 's3cret-password' } });
  assert.strictEqual(ok.statusCode, 200);
  assert.match(ok.headers['set-cookie'], /HttpOnly; Secure; SameSite=Strict/);
  const cookie = cookieOf(ok);

  const ws = await call(me, { headers: { cookie } });
  assert.strictEqual(ws.json.email, 'pat@example.com');
  assert.deepStrictEqual(ws.json.apps.map((a) => a.id), ['bookscan']);

  const dl = await call(appDownload, { url: '/api/app-download?product=bookscan', headers: { cookie } });
  assert.strictEqual(dl.statusCode, 302);
  assert.match(dl.headers.location, /X-Amz-Expires=120/);

  await call(logout, { method: 'POST', headers: { cookie } });
  assert.strictEqual((await call(me, { headers: { cookie } })).statusCode, 401);
});

test('download refuses products the account does not own', async () => {
  await store.setJSON('user:none@example.com', { hash: await auth.hashPassword('another-password'), products: [] });
  const cookie = cookieOf(await call(login, { method: 'POST', body: { email: 'none@example.com', password: 'another-password' } }));
  assert.strictEqual((await call(appDownload, { url: '/api/app-download?product=bookscan', headers: { cookie } })).statusCode, 403);
  assert.strictEqual((await call(appDownload, { url: '/api/app-download?product=__proto__', headers: { cookie } })).statusCode, 404);
});

test('login rejects form posts and rate-limits per email', async () => {
  assert.strictEqual((await call(login, { method: 'POST', body: 'email=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode, 415);
  let last;
  for (let i = 0; i < 9; i++) last = await call(login, { method: 'POST', body: { email: 'victim@example.com', password: 'guess' + i } });
  assert.strictEqual(last.statusCode, 429);
});

test('in-memory store honours TTLs', async () => {
  await store.setJSON('ttl:x', { a: 1 }, 1);
  assert.deepStrictEqual(await store.getJSON('ttl:x'), { a: 1 });
  await new Promise((r) => setTimeout(r, 1100));
  assert.strictEqual(await store.getJSON('ttl:x'), null);
});

const download = require('../api/download');

test('session download: failed checks do not use up the allowance; removed products return 410', async () => {
  const sid = 'cs_test_dlcount000001';
  await store.setJSON(`order:${sid}`, { productId: 'bookscan', subscriptionId: 'sub_gone' });
  for (let i = 0; i < 12; i++) assert.strictEqual((await call(download, { url: `/api/download?session_id=${sid}` })).statusCode, 403);
  await store.setJSON('sub:sub_gone', { status: 'active' });
  const ok = await call(download, { url: `/api/download?session_id=${sid}` });
  assert.strictEqual(ok.statusCode, 302);
  assert.match(ok.headers.location, /X-Amz-Expires=300/);

  const old = 'cs_test_removed000001';
  await store.setJSON(`order:${old}`, { productId: 'retired-product' });
  assert.strictEqual((await call(download, { url: `/api/download?session_id=${old}` })).statusCode, 410);
  assert.strictEqual((await call(require('../api/order'), { url: `/api/order?session_id=${old}` })).statusCode, 410);
});

test('remote incr sets the TTL before incrementing', async () => {
  const sent = [];
  const realFetch = global.fetch;
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://kv.example.com', UPSTASH_REDIS_REST_TOKEN: 't' });
  global.fetch = async (_u, o) => { sent.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ result: sent.length === 1 ? 'OK' : 1 }) }; };
  try {
    assert.strictEqual(await store.incr('rl:x', 900), 1);
    assert.deepStrictEqual(sent, [['SET', 'rl:x', '0', 'NX', 'EX', '900'], ['INCR', 'rl:x']]);
  } finally {
    global.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});
