const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildBlog, parsePost } = require('../scripts/build-blog');

const NOW = Date.parse('2026-11-02T08:00:00-07:00');

function site(posts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-'));
  fs.mkdirSync(path.join(root, 'blog', 'posts'), { recursive: true });
  for (const [name, text] of Object.entries(posts)) fs.writeFileSync(path.join(root, 'blog', 'posts', name), text);
  return root;
}

const post = (slug, date, status = 'scheduled', extra = '') => `---
title: ${JSON.stringify(`Post ${slug}`)}
slug: ${slug}
date: ${date}
description: "About ${slug}"
status: ${status}
${extra}---
# Post ${slug}

Body of **${slug}**.

| a | b |
|---|---|
| 1 | 2 |
`;

test('only due posts are published, newest first', () => {
  const root = site({
    'a.md': post('older', '2026-10-26T06:00:00-06:00'),
    'b.md': post('newer', '2026-11-02T06:00:00-07:00', 'published'),
    'c.md': post('future', '2026-11-09T06:00:00-07:00'),
    'd.md': post('draft', '2026-10-01T06:00:00-06:00', 'draft'),
    'e.md': post('nostatus', '2026-10-20T06:00:00-06:00').replace('status: scheduled\n', ''),
  });
  const out = path.join(root, 'dist');
  assert.deepStrictEqual(buildBlog({ root, out, now: NOW }), ['newer', 'older', 'nostatus']);
  const index = fs.readFileSync(path.join(out, 'blog/index.html'), 'utf8');
  assert.ok(index.indexOf('/blog/newer/') < index.indexOf('/blog/older/'));
  assert.ok(!index.includes('future') && !index.includes('/blog/draft/'));
  assert.ok(!fs.existsSync(path.join(out, 'blog/future')));
  const sm = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
  assert.match(sm, /\/blog\/newer\/<\/loc><lastmod>2026-11-02/);
  assert.ok(!sm.includes('future'));
});

test('a post page has one heading, rendered Markdown and article metadata', () => {
  const root = site({ 'a.md': post('hello', '2026-10-26T06:00:00-06:00') });
  buildBlog({ root, out: path.join(root, 'dist'), now: NOW });
  const html = fs.readFileSync(path.join(root, 'dist/blog/hello/index.html'), 'utf8');
  assert.strictEqual(html.match(/<h1>/g).length, 1);
  assert.match(html, /<strong>hello<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/snowseasonstech.net\/blog\/hello\/">/);
  assert.match(html, /"@type":"BlogPosting"/);
  assert.match(html, /October 26, 2026/);
});

test('titles are escaped and JSON-LD cannot close the script tag', () => {
  const root = site({ 'a.md': post('x', '2026-10-26T06:00:00-06:00').replace('"Post x"', '"A </script><b>bold</b> title"') });
  buildBlog({ root, out: path.join(root, 'dist'), now: NOW });
  const html = fs.readFileSync(path.join(root, 'dist/blog/x/index.html'), 'utf8');
  assert.ok(!html.includes('<b>bold</b> title</h1>'));
  assert.strictEqual(html.split('</script>').length, 2);
});

test('an empty blog still gets a landing page', () => {
  const root = site({});
  assert.deepStrictEqual(buildBlog({ root, out: path.join(root, 'dist'), now: NOW }), []);
  assert.match(fs.readFileSync(path.join(root, 'dist/blog/index.html'), 'utf8'), /on the way/);
});

test('bad posts fail the build', () => {
  assert.throws(() => parsePost(post('Bad Slug', '2026-10-26T06:00:00-06:00'), 'f.md'), /slug/);
  assert.throws(() => parsePost(post('ok', 'someday'), 'f.md'), /date/);
  assert.throws(() => parsePost('no front matter', 'f.md'), /front matter/);
  const root = site({ 'a.md': post('same', '2026-10-26T06:00:00-06:00'), 'b.md': post('same', '2026-10-27T06:00:00-06:00') });
  assert.throws(() => buildBlog({ root, out: path.join(root, 'dist'), now: NOW }), /duplicate slug/);
});

test('BLOG_BUILD_TIME previews another date', () => {
  const root = site({ 'a.md': post('soon', '2026-11-09T06:00:00-07:00') });
  process.env.BLOG_BUILD_TIME = '2026-11-09T07:00:00-07:00';
  try {
    assert.deepStrictEqual(buildBlog({ root, out: path.join(root, 'dist') }), ['soon']);
  } finally {
    delete process.env.BLOG_BUILD_TIME;
  }
});

// Expiring image links

test('presign matches the AWS SigV4 example', async () => {
  const { presign } = await import('../functions/_lib/presign.js');
  const url = await presign({
    host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', expires: 86400, now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'), url);
});

const ENV = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK', R2_BUCKET: 'site-media' };
const KEY = 'blog/my-post/0123456789abcdef.jpg';
const img = async (key, env = ENV) => (await import('../functions/blog-img/[[path]].js')).onRequestGet({ params: { path: key.split('/') }, env });

test('blog images redirect to a signed R2 URL that expires in an hour', async () => {
  const res = await img(KEY);
  assert.strictEqual(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.strictEqual(loc.host, 'acct.r2.cloudflarestorage.com');
  assert.strictEqual(loc.pathname, `/site-media/${KEY}`);
  assert.strictEqual(loc.searchParams.get('X-Amz-Expires'), '3600');
  assert.ok(loc.searchParams.get('X-Amz-Signature'));
  assert.ok(!res.headers.get('Location').includes('SK'));
  assert.strictEqual(res.headers.get('Cache-Control'), 'private, max-age=1800');
  assert.ok(res.headers.get('Content-Security-Policy'));
  const short = await img(KEY, { ...ENV, BLOG_IMAGE_TTL: '600' });
  assert.strictEqual(new URL(short.headers.get('Location')).searchParams.get('X-Amz-Expires'), '600');
});

test('only blog image keys are signed', async () => {
  for (const key of ['postbox/abc.jpg', 'blog/x/../../secret.jpg', 'blog/My-Post/0123456789abcdef.jpg', 'blog/p/0123456789abcdef.exe', 'blog/p/short.jpg']) {
    assert.strictEqual((await img(key)).status, 404, key);
  }
});

test('image links answer 503 until R2 is configured', async () => {
  assert.strictEqual((await img(KEY, {})).status, 503);
});
