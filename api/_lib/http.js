function send(res, code, body, headers = {}) {
  res.statusCode = code;
  const isObj = body !== null && typeof body === 'object';
  res.setHeader('Content-Type', isObj ? 'application/json' : 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(isObj ? JSON.stringify(body) : body || '');
}
function allow(req, res, method) {
  if (req.method === method) return true;
  send(res, 405, { error: 'Method not allowed' }, { Allow: method });
  return false;
}
async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
module.exports = { send, allow, readRaw };
