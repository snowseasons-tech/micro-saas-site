#!/usr/bin/env node
// Upload a deliverable to the private S3/R2 bucket that /api/download and /api/app-download serve from.
//   S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... node scripts/upload.js <local file> <fileKey>
// <fileKey> must match the product's fileKey in api/_lib/catalog.js. Prints the sha256 to paste into the catalog.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { presignPutFromEnv } = require('../api/_lib/sigv4');

const TYPES = { '.html': 'text/html', '.zip': 'application/zip', '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain' };

async function main() {
  const [localPath, key] = process.argv.slice(2);
  if (!localPath || !key) throw new Error('usage: node scripts/upload.js <local file> <fileKey>');
  const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')}`);

  const body = fs.readFileSync(localPath);
  const contentType = TYPES[path.extname(localPath).toLowerCase()] || 'application/octet-stream';
  const r = await fetch(presignPutFromEnv(key), { method: 'PUT', body, headers: { 'Content-Type': contentType } });
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
  console.error(`Uploaded ${localPath} -> ${process.env.S3_BUCKET}/${key} (${contentType})`);
  console.log(`sha256: ${crypto.createHash('sha256').update(body).digest('hex')}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
