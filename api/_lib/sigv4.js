// AWS Signature V4 query-string presigner for GET/PUT (S3 / Cloudflare R2). No dependencies.
const crypto = require('crypto');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function presign({ method = 'GET', host, path, region, accessKeyId, secretAccessKey, expires = 300, now = new Date(), extraQuery = {} }) {
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
  const date = amz.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const q = {
    ...extraQuery,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonQuery = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonPath = path.split('/').map(enc).join('/');
  const canonical = [method, canonPath, canonQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amz, scope, hex(canonical)].join('\n');
  let k = hmac('AWS4' + secretAccessKey, date);
  k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');
  return `https://${host}${canonPath}?${canonQuery}&X-Amz-Signature=${sig}`;
}

const presignGet = (opts) => presign({ ...opts, method: 'GET' });

const envTarget = (key, env) => ({
  host: new URL(env.S3_ENDPOINT).host,
  path: `/${env.S3_BUCKET}/${key}`,
  region: env.S3_REGION || 'auto',
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});
function presignFromEnv(key, filename, env = process.env, expires = 300) {
  return presign({
    ...envTarget(key, env),
    expires,
    extraQuery: { 'response-content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"` },
  });
}
// Used by scripts/upload.js to put files into the same bucket downloads are served from.
const presignPutFromEnv = (key, env = process.env, expires = 300) => presign({ ...envTarget(key, env), method: 'PUT', expires });
module.exports = { presign, presignGet, presignFromEnv, presignPutFromEnv };
