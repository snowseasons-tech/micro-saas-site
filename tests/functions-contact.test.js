const test = require('node:test');
const assert = require('node:assert');
const fakeUpstash = require('./fake-upstash');

const env = {
  UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't',
  RESEND_API_KEY: 're_1', MAIL_FROM: 'site@site.test', CONTACT_TO: 'owner@site.test',
};
Object.assign(process.env, env);
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const good = { name: 'Pat', email: 'pat@example.com', company: 'Acme', service: 'Custom business app', message: 'We track jobs in three spreadsheets.' };

function setup(e = env) {
  const mailed = [];
  const up = fakeUpstash((url, init) => {
    if (url === 'https://api.resend.com/emails') { mailed.push(JSON.parse(init.body)); return json({ id: 'em_1' }); }
    throw new Error(`unexpected fetch ${url}`);
  });
  const post = async (body, ip = '1.2.3.4') => {
    const { onRequestPost } = await import('../functions/api/contact.js');
    return onRequestPost({ request: new Request('https://x.test/api/contact', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env: e });
  };
  return { mailed, post, restore: up.restore };
}

test('contact emails the owner with Reply-To set to the sender', async () => {
  const t = setup();
  try {
    const res = await t.post(good);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { sent: true });
    assert.strictEqual(t.mailed.length, 1);
    const [m] = t.mailed;
    assert.deepStrictEqual([m.to, m.reply_to, m.from], [['owner@site.test'], 'pat@example.com', 'site@site.test']);
    assert.strictEqual(m.subject, 'Project inquiry: Pat (Acme)');
    assert.match(m.text, /Service: Custom business app/);
    assert.match(m.text, /three spreadsheets/);
  } finally { t.restore(); }
});

test('contact validates input and keeps newlines out of the subject', async () => {
  const t = setup();
  try {
    assert.strictEqual((await t.post('{bad')).status, 400);
    assert.strictEqual((await t.post({ ...good, name: '' })).status, 400);
    assert.strictEqual((await t.post({ ...good, email: 'nope' })).status, 400);
    assert.strictEqual((await t.post({ ...good, message: 'hi' })).status, 400);
    assert.strictEqual((await t.post({ ...good, message: 'x'.repeat(5001) })).status, 400);
    assert.strictEqual(t.mailed.length, 0);
    assert.strictEqual((await t.post({ ...good, name: 'Pat\r\nBcc: x@evil.test' })).status, 200);
    assert.doesNotMatch(t.mailed[0].subject, /[\r\n]/);
  } finally { t.restore(); }
});

test('contact silently drops honeypot submissions', async () => {
  const t = setup();
  try {
    const res = await t.post({ ...good, website: 'http://spam.test' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(t.mailed.length, 0);
  } finally { t.restore(); }
});

test('contact rate-limits per IP', async () => {
  const t = setup();
  try {
    for (let i = 0; i < 5; i++) assert.strictEqual((await t.post(good, '9.9.9.9')).status, 200);
    assert.strictEqual((await t.post(good, '9.9.9.9')).status, 429);
    assert.strictEqual((await t.post(good, '8.8.8.8')).status, 200);
  } finally { t.restore(); }
});

test('contact reports 503 when email is not configured', async () => {
  const t = setup({ ...env, CONTACT_TO: '' });
  try {
    assert.strictEqual((await t.post(good)).status, 503);
    assert.strictEqual(t.mailed.length, 0);
  } finally { t.restore(); }
});

test('contact only accepts POST', async () => {
  const { onRequest } = await import('../functions/api/contact.js');
  const res = await onRequest();
  assert.strictEqual(res.status, 405);
  assert.strictEqual(res.headers.get('allow'), 'POST');
});
