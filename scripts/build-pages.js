#!/usr/bin/env node
// Builds dist/ for Cloudflare Pages from an allowlist, so products/, private-files/, api/, scripts/, tests/
// and env files can never be published. Functions are picked up from functions/ at the project root.
const fs = require('fs');
const path = require('path');

const PUBLIC_DIRS = ['storefront'];
const PUBLIC_FILES = ['page.css'];
const isPublic = (name) => !name.startsWith('.') && !name.endsWith('.md');

function build({ root = path.join(__dirname, '..'), out = path.join(root, 'dist') } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const copy = (rel) => {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) throw new Error(`missing ${rel}`);
    fs.cpSync(from, path.join(out, rel), { recursive: true, filter: (src) => isPublic(path.basename(src)) });
  };
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  if (!pages.includes('index.html')) throw new Error('missing index.html');
  [...pages, ...PUBLIC_FILES, ...PUBLIC_DIRS].forEach(copy);
  fs.copyFileSync(path.join(root, 'pages', '_headers'), path.join(out, '_headers'));
  return out;
}

if (require.main === module) console.log(`built ${build()}`);
module.exports = { build };
