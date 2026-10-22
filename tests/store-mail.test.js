const test = require('node:test');
const assert = require('node:assert');
const store = require('../api/_lib/store');
const mail = require('../api/_lib/mail');

test('in-memory store honours TTLs', async () => {
  await store.setJSON('ttl:x', { a: 1 }, 1);
  assert.deepStrictEqual(await store.getJSON('ttl:x'), { a: 1 });
  await new Promise((r) => setTimeout(r, 1100));
  assert.strictEqual(await store.getJSON('ttl:x'), null);
});

test('remote incr increments and sets the TTL in one atomic call', async () => {
  const sent = [];
  const realFetch = global.fetch;
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://kv.example.com', UPSTASH_REDIS_REST_TOKEN: 't' });
  global.fetch = async (_u, o) => { sent.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ result: 1 }) }; };
  try {
    assert.strictEqual(await store.incr('rl:x', 900), 1);
    assert.strictEqual(sent.length, 1);
    const [op, script, nkeys, key, ttl] = sent[0];
    assert.deepStrictEqual([op, nkeys, key, ttl], ['EVAL', '1', 'rl:x', '900']);
    assert.match(script, /INCR[\s\S]*TTL[\s\S]*EXPIRE/);
  } finally {
    global.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test('mail module skips without config', async () => {
  assert.strictEqual(await mail.sendMail({ to: 'a@b.co', subject: 's', text: 't' }, {}), 'skipped');
});
