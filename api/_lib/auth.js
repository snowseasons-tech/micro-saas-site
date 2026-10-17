// Customer portal auth: admin-provisioned accounts, scrypt password hashes, opaque server-side sessions.
// Account record  user:<email> = { hash, products: [catalogId, ...] }  (create with scripts/add-user.js)
// Session record  sess:<sha256(token)> = { email }  (the raw token only ever lives in the HttpOnly cookie)
const crypto = require('crypto');
const store = require('./store');

const COOKIE = 'ss_session';
const SESSION_TTL_SEC = 8 * 60 * 60;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const LOGIN_WINDOW_SEC = 15 * 60;
const LOGIN_MAX_PER_IP = 20;
const LOGIN_MAX_PER_EMAIL = 8;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}

// Format: scrypt$N$r$p$<salt b64>$<hash b64>
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, keylen: expected.length });
  return crypto.timingSafeEqual(key, expected);
}

// Unknown emails still pay for one scrypt so response time doesn't reveal which accounts exist.
let dummyHash;
async function checkCredentials(email, password, s = store) {
  const user = await s.getJSON(`user:${normEmail(email)}`);
  if (!user) {
    dummyHash = dummyHash || (await hashPassword(crypto.randomBytes(16).toString('hex')));
    await verifyPassword(password, dummyHash);
    return null;
  }
  return (await verifyPassword(password, user.hash)) ? user : null;
}

// Returns true when the caller is over either limit for the current window.
async function loginLimited(ip, email, s = store) {
  const byIp = await s.incr(`rl:login:ip:${ip}`, LOGIN_WINDOW_SEC);
  const byEmail = await s.incr(`rl:login:email:${sha256(normEmail(email))}`, LOGIN_WINDOW_SEC);
  return byIp > LOGIN_MAX_PER_IP || byEmail > LOGIN_MAX_PER_EMAIL;
}

async function createSession(email, s = store) {
  const token = crypto.randomBytes(32).toString('base64url');
  await s.setJSON(`sess:${sha256(token)}`, { email: normEmail(email), createdAt: Date.now() }, SESSION_TTL_SEC);
  return token;
}
function readToken(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`));
  return m ? m[1] : null;
}
// Resolves the signed-in account, or null. Dropped accounts lose access immediately.
async function getSession(req, s = store) {
  const token = readToken(req);
  if (!token) return null;
  const sess = await s.getJSON(`sess:${sha256(token)}`);
  if (!sess) return null;
  const user = await s.getJSON(`user:${sess.email}`);
  return user ? { email: sess.email, products: user.products || [] } : null;
}
async function destroySession(req, s = store) {
  const token = readToken(req);
  if (token) await s.release(`sess:${sha256(token)}`);
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SEC}`;
}
const clearCookie = () => `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = {
  normEmail, hashPassword, verifyPassword, checkCredentials, loginLimited,
  createSession, getSession, destroySession, sessionCookie, clearCookie, clientIp,
};
