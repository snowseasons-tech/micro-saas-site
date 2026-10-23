// AWS Signature V4 presigned URLs (R2 speaks the S3 API), with Web Crypto so it runs in Pages Functions and Node.
// Only the host header is signed, so the URL works as a plain <img> request.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const hmac = async (key, s) => crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(s));
// encodeURIComponent leaves !'()* alone; SigV4 wants them escaped
const uri = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export async function presign({ method = 'GET', host, path, accessKey, secretKey, region = 'auto', expires = 3600, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKey}/${scope}`, 'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host',
  };
  const qs = Object.keys(q).sort().map((k) => `${uri(k)}=${uri(q[k])}`).join('&');
  const canonPath = path.split('/').map(uri).join('/');
  const creq = [method, canonPath, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(creq)].join('\n');
  let key = enc.encode(`AWS4${secretKey}`);
  for (const part of [date, region, 's3', 'aws4_request']) key = await hmac(key, part);
  return `https://${host}${canonPath}?${qs}&X-Amz-Signature=${hex(await hmac(key, toSign))}`;
}
