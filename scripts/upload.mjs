import { put } from '@vercel/blob';
import { readFile } from 'node:fs/promises';

const [localPath, blobPath] = process.argv.slice(2);
if (!localPath || !blobPath) {
  console.error('Usage: node upload.mjs <local file> <blob path>');
  process.exit(1);
}

const body = await readFile(localPath);
const blob = await put(blobPath, body, {
  access: 'private',
  addRandomSuffix: false,
  contentType: 'text/html',
});
console.log('Uploaded:', blob.pathname);
