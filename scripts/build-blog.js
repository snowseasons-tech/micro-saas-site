// Renders the blog into dist/: a landing page at /blog/, one page per post at /blog/<slug>/, and sitemap.xml.
// Posts are Markdown files in blog/posts/, exported from MariaDB by the mariadb-auto-blogger skill. A post is
// published once its date has passed (unless it says status: draft), so future posts can be
// committed early and go live on the first build after their date (a daily rebuild runs from GitHub Actions).
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const SITE = 'https://snowseasonstech.net';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIVE = new Set(['scheduled', 'published']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parsePost(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    meta[kv[1]] = v.startsWith('"') ? JSON.parse(v) : v;
  }
  if (!SLUG_RE.test(meta.slug || '')) throw new Error(`${file}: bad or missing slug`);
  if (!meta.title) throw new Error(`${file}: missing title`);
  const time = Date.parse(meta.date);
  if (Number.isNaN(time)) throw new Error(`${file}: bad or missing date`);
  // The page shows the title as its heading, so drop a leading "# Title" line from the body
  const body = m[2].replace(/^\s*# .*\n/, '');
  return { ...meta, time, body };
}

function loadPosts(dir) {
  if (!fs.existsSync(dir)) return [];
  const posts = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => parsePost(fs.readFileSync(path.join(dir, f), 'utf8'), f));
  const seen = new Set();
  for (const p of posts) {
    if (seen.has(p.slug)) throw new Error(`duplicate slug ${p.slug}`);
    seen.add(p.slug);
  }
  return posts;
}

// Exported posts carry no status (they're on the site once due); a hand-written status: draft keeps a file off it
const duePosts = (posts, now) => posts.filter((p) => (!p.status || LIVE.has(p.status)) && p.time <= now).sort((a, b) => b.time - a.time);

const day = (t) => new Date(t).toLocaleDateString('en-US', { timeZone: 'America/Denver', year: 'numeric', month: 'long', day: 'numeric' });

function page({ title, description, canonical, body, head = '' }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="stylesheet" href="/page.css">${head}</head>
<body><header><div class="container"><a class="logo" href="/">Snow Seasons Technology</a> <a class="nav" href="/blog/">Blog</a></div></header>
<main class="container">
${body}
</main>
<footer><a href="/blog/">Blog</a><a href="/privacy">Privacy</a><a href="https://snowseasonstech.store">Store</a><p>&copy; 2026 snowseasonstech.net</p></footer>
</body></html>
`;
}

function renderPost(p) {
  const url = `${SITE}/blog/${p.slug}/`;
  const ld = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, description: p.description || '',
    datePublished: new Date(p.time).toISOString(), mainEntityOfPage: url,
    author: { '@type': 'Organization', name: p.author || 'Snow Seasons Technologies' },
  };
  const head = `
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(url)}">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  return page({
    title: `${p.title} | Snow Seasons Tech`, description: p.description, canonical: url, head,
    body: `<article class="post"><p class="muted"><a href="/blog/">Blog</a> · <time datetime="${new Date(p.time).toISOString()}">${day(p.time)}</time></p>
<h1>${esc(p.title)}</h1>
${marked.parse(p.body)}
<p class="cta">Want something like this built for your team? <a class="btn" href="/#contact">Start a project</a></p>
</article>`,
  });
}

function renderIndex(posts) {
  const items = posts.map((p) => `<li class="post-item"><a href="/blog/${p.slug}/"><h2>${esc(p.title)}</h2></a>
<p class="muted"><time datetime="${new Date(p.time).toISOString()}">${day(p.time)}</time></p><p>${esc(p.description)}</p></li>`).join('\n');
  return page({
    title: 'Blog | Snow Seasons Tech',
    description: 'Practical writing on custom business apps, automation and dashboards for small and growing teams.',
    canonical: `${SITE}/blog/`,
    body: `<h1>Blog</h1><p class="muted">Practical writing on custom business apps, automation and dashboards for small and growing teams.</p>
${posts.length ? `<ul class="post-list">\n${items}\n</ul>` : '<p>New articles are on the way. Check back soon.</p>'}`,
  });
}

function sitemap(posts) {
  const urls = [['/', null], ['/privacy', null], ['/blog/', posts[0]?.time], ...posts.map((p) => [`/blog/${p.slug}/`, p.time])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([u, t]) => `  <url><loc>${SITE}${u}</loc>${t ? `<lastmod>${new Date(t).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}

// now: ms since epoch. BLOG_BUILD_TIME (any Date.parse-able string) previews the site as of another moment.
function buildBlog({ root, out, now = process.env.BLOG_BUILD_TIME ? Date.parse(process.env.BLOG_BUILD_TIME) : Date.now() }) {
  if (Number.isNaN(now)) throw new Error('BLOG_BUILD_TIME is not a valid date');
  const posts = duePosts(loadPosts(path.join(root, 'blog', 'posts')), now);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.writeFileSync(path.join(out, rel), text);
  };
  write('blog/index.html', renderIndex(posts));
  for (const p of posts) write(`blog/${p.slug}/index.html`, renderPost(p));
  write('sitemap.xml', sitemap(posts));
  return posts.map((p) => p.slug);
}

module.exports = { buildBlog, loadPosts, duePosts, parsePost };
