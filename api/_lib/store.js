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
    signal: AbortSignal.timeout(10000),
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
  if (ttlSec) expiry.set(key, Date.now() + ttlSec * 1000);
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
// INCR, and give the key its TTL if it has none, in one atomic script so a counter can't be left without expiry.
const INCR_TTL = "local n = redis.call('INCR', KEYS[1]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n";

// ttlSec (optional) starts the expiry window on the first increment.
async function incr(key, ttlSec) {
  requireStore();
  if (hasRemote()) return ttlSec ? cmd(['EVAL', INCR_TTL, '1', key, String(ttlSec)]) : cmd(['INCR', key]);
  const n = Number(memGet(key) || 0) + 1;
  mem.set(key, String(n));
  if (ttlSec && n === 1) expiry.set(key, Date.now() + ttlSec * 1000);
  return n;
}
// Current value of an incr() counter (0 when missing or expired).
async function count(key) {
  requireStore();
  return Number((hasRemote() ? await cmd(['GET', key]) : memGet(key)) || 0);
}
module.exports = { claim, release, setJSON, getJSON, incr, count };
