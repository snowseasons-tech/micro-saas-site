const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('../scripts/build-pages');

const root = path.join(__dirname, '..');
const list = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]));

test('dist contains only the public site', () => {
  const out = build({ root, out: fs.mkdtempSync(path.join(os.tmpdir(), 'dist-')) });
  const files = list(out).sort();
  assert.deepStrictEqual(files, ['404.html', '_headers', 'index.html', 'page.css', 'privacy.html']);
});

test('dist is rebuilt from scratch and fails on a missing index', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  assert.throws(() => build({ root: tmp, out: path.join(tmp, 'dist') }), /index\.html/);
});

test('security headers match across Functions and pages/_headers', async () => {
  const { SECURITY_HEADERS } = await import('../functions/_lib/headers.js');
  const { send } = await import('../functions/_lib/http.js');
  const parsed = Object.fromEntries(fs.readFileSync(path.join(root, 'pages/_headers'), 'utf8').split('\n')
    .filter((l) => /^\s+\S+: /.test(l)).map((l) => l.trim().split(/: (.*)/s).slice(0, 2)));
  assert.deepStrictEqual(parsed, SECURITY_HEADERS);
  const res = send(200, { ok: true });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.strictEqual(res.headers.get(k), v);
});
