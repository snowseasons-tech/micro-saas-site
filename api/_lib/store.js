// Tiny KV: Upstash Redis REST in production, in-memory Map for local dev/tests.
const mem = new Map();
const expiry = new Map();
function memGet(key) {
  if (expiry.has(key) && expiry.get(key) <= Date.now()) { mem.delete(key); expiry.delete(key); }
  return mem.get(key);
}
const URL_ = () => process.env.UPSTASH_REDIS_REST_URL;
const hasRemote = () => !!(URL_() && process.env.UPSTASH_REDIS_REST_TOKEN);

async function cmd(args) {
  const r = await fetch(URL_(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`store ${r.status}`);
  return (await r.json()).result;
}
function requireStore() {
  if (!hasRemote() && process.env.NODE_ENV === 'production') throw new Error('Persistent store not configured');
}

// Returns true if this caller got the claim (first time), false if already claimed.
async function claim(key, ttlSec) {
  requireStore();
  if (hasRemote()) return (await cmd(['SET', key, '1', 'NX', 'EX', String(ttlSec)])) === 'OK';
  if (memGet(key) !== undefined) return false;
  mem.set(key, '1');
  return true;
}
async function release(key) {
  if (hasRemote()) return void (await cmd(['DEL', key]));
  mem.delete(key);
  expiry.delete(key);
}
// ttlSec (optional) expires the key; the in-memory fallback checks expiry on read.
async function setJSON(key, val, ttlSec) {
  requireStore();
  if (hasRemote()) return void (await cmd(ttlSec ? ['SET', key, JSON.stringify(val), 'EX', String(ttlSec)] : ['SET', key, JSON.stringify(val)]));
  mem.set(key, JSON.stringify(val));
  if (ttlSec) expiry.set(key, Date.now() + ttlSec * 1000);
}
async function getJSON(key) {
  requireStore();
  const v = hasRemote() ? await cmd(['GET', key]) : memGet(key);
  return v ? JSON.parse(v) : null;
}
// ttlSec (optional) starts the expiry window on the first increment.
async function incr(key, ttlSec) {
  requireStore();
  if (hasRemote()) {
    const n = await cmd(['INCR', key]);
    if (ttlSec && n === 1) await cmd(['EXPIRE', key, String(ttlSec)]);
    return n;
  }
  const n = Number(memGet(key) || 0) + 1;
  mem.set(key, String(n));
  if (ttlSec && n === 1) expiry.set(key, Date.now() + ttlSec * 1000);
  return n;
}
module.exports = { claim, release, setJSON, getJSON, incr };
