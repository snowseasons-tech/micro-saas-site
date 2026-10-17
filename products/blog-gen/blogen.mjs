#!/usr/bin/env node
// blogen: scrape-only blog roundup generator (no APIs, no LLMs).
// Usage: node blogen.mjs [--config sources.json] [--topic "name"] [--browser] [--dry]
//        [--commentary file.md] [--publish hugo|wordpress|ghost] [--live]
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { marked } from 'marked';

// ---------- CLI ----------
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const CONFIG = opt('config', 'sources.json');
const ONLY_TOPIC = opt('topic');
const FORCE_BROWSER = flag('browser');
const DRY = flag('dry');
const PUBLISH = opt('publish');
const COMMENTARY_FILE = opt('commentary');
const STATUS = flag('live') ? 'publish' : 'draft'; // drafts by default so you can add commentary

const cfg = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
const UA = cfg.userAgent || 'BlogGenBot/1.0';
const DELAY = cfg.delayMs ?? 2000;
const MAX_EXCERPT = cfg.maxExcerptWords ?? 60;
const SUM_N = cfg.summarySentences ?? 3;
const OUT = cfg.outDir || 'out';
const SEEN_FILE = path.join(OUT, '.seen.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const log = (...a) => console.error('[blogen]', ...a);
const FETCH_TIMEOUT_MS = cfg.fetchTimeoutMs ?? 30000;
const timeoutSignal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS); // covers the body read, not just the headers

// Scraped text is untrusted: marked passes raw HTML through, so escape every Markdown/HTML
// special character (rendered as plain text) and only allow http(s) links.
const mdEscape = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[\\`*_{}\[\]()#+!|<>&~]/g, '\\$&');
function safeUrl(u) {
  try {
    const x = new URL(u);
    return ['http:', 'https:'].includes(x.protocol) ? x.href.replace(/[()]/g, (ch) => (ch === '(' ? '%28' : '%29')) : null;
  } catch { return null; }
}

// ---------- Politeness: robots.txt + rate limit ----------
const robotsCache = new Map();
async function allowed(url) {
  const { origin } = new URL(url);
  if (!robotsCache.has(origin)) {
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: timeoutSignal() });
      robotsCache.set(origin, robotsParser(`${origin}/robots.txt`, res.ok ? await res.text() : ''));
    } catch { robotsCache.set(origin, robotsParser(`${origin}/robots.txt`, '')); }
  }
  return robotsCache.get(origin).isAllowed(url, UA) !== false;
}

let lastHit = 0;
async function throttle() {
  const wait = lastHit + DELAY - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit = Date.now();
}

// ---------- Fetching (Cheerio path, Playwright fallback) ----------
let browser;
async function fetchWithBrowser(url) {
  let pw;
  try { pw = await import('playwright'); }
  catch { throw new Error('Playwright not installed: npm i playwright && npx playwright install chromium'); }
  browser ??= await pw.chromium.launch();
  const page = await browser.newPage({ userAgent: UA });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    return await page.content();
  } finally { await page.close(); }
}

async function fetchHtml(url) {
  if (!(await allowed(url))) { log('blocked by robots.txt, skipping', url); return null; }
  await throttle();
  if (FORCE_BROWSER) return fetchWithBrowser(url);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml' }, redirect: 'follow', signal: timeoutSignal() });
  if (!res.ok) { log(`HTTP ${res.status}`, url); return null; }
  const html = await res.text();
  // Looks like a JS shell? Retry with a real browser if available.
  if (!html.includes('<p') && !url.match(/\.(xml|rss|atom)$/)) {
    try { return await fetchWithBrowser(url); } catch { /* keep static */ }
  }
  return html;
}

// ---------- Link discovery ----------
async function discover(src) {
  const limit = src.limit ?? 5;
  if (src.mode === 'page') return [src.url];
  const html = await fetchHtml(src.url);
  if (!html) return [];
  const $ = cheerio.load(html, { xmlMode: src.mode === 'feed' });
  let links = [];
  if (src.mode === 'feed') {
    $('item > link, entry > link').each((_, el) => {
      const href = $(el).attr('href') || $(el).text().trim();
      if (href) links.push(href);
    });
  } else {
    $(src.linkSelector || 'article a').each((_, el) => {
      const h = $(el).attr('href');
      if (h) { try { links.push(new URL(h, src.url).href); } catch {} }
    });
  }
  return [...new Set(links.map(safeUrl).filter(Boolean))].slice(0, limit);
}

// ---------- Extraction ----------
function extract(html, url) {
  const $ = cheerio.load(html);
  const meta = (p) => $(`meta[property="${p}"], meta[name="${p}"]`).attr('content')?.trim();
  $('script, style, nav, footer, aside, form, noscript, .comments, .share, .newsletter').remove();

  const title = meta('og:title') || $('h1').first().text().trim() || $('title').text().trim();
  const description = meta('og:description') || meta('description') || '';
  let image = null;
  try { image = meta('og:image') ? safeUrl(new URL(meta('og:image'), url).href) : null; } catch {}
  const date = meta('article:published_time') || $('time[datetime]').first().attr('datetime') || null;
  const author = meta('author') || $('[rel="author"]').first().text().trim() || null;
  const site = meta('og:site_name') || new URL(url).hostname.replace(/^www\./, '');

  const root = ['article', 'main', '[role="main"]', '.post-content', '.entry-content', 'body']
    .map((s) => $(s).first()).find((el) => el.length && el.find('p').length >= 2) || $('body');
  const paragraphs = root.find('p').map((_, p) => $(p).text().replace(/\s+/g, ' ').trim()).get()
    .filter((t) => t.length > 50);

  return { url, title, description, image, date, author, site, text: paragraphs.join(' ') };
}

// ---------- Extractive summarizer (frequency scoring, no ML) ----------
const STOP = new Set('a an the and or but if then of to in on for with as at by from is are was were be been it its this that these those i you he she we they not no do does did have has had will would can could should about into over than so such also more most other their there which who what when where how'.split(' '));
const words = (s) => s.toLowerCase().match(/[a-z][a-z'-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? [];

function summarize(text, n) {
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)/g)?.map((s) => s.trim()).filter((s) => s.length > 40 && s.length < 320) ?? [];
  if (sentences.length <= n) return sentences;
  const freq = {};
  words(text).forEach((w) => (freq[w] = (freq[w] || 0) + 1));
  const scored = sentences.map((s, i) => {
    const ws = words(s);
    const score = ws.reduce((a, w) => a + (freq[w] || 0), 0) / (ws.length || 1) * (i < 3 ? 1.2 : 1);
    return { s, i, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s);
}

function keyTerms(text, n = 5) {
  const freq = {};
  words(text).forEach((w) => (freq[w] = (freq[w] || 0) + 1));
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

function clip(s, maxWords) {
  const w = s.split(/\s+/);
  return w.length <= maxWords ? s : w.slice(0, maxWords).join(' ') + '…';
}

// ---------- Rendering ----------
const DEFAULT_TPL = `{{frontmatter}}
# {{title}}

{{intro}}

{{commentary}}
{{items}}

## Sources

{{sources}}
`;

// Placeholders: {{frontmatter}} {{title}} {{date}} {{intro}} {{commentary}} {{items}} {{sources}} {{tags}}
function renderPost(topic, items, commentary, template) {
  const date = new Date().toISOString().slice(0, 10);
  const tags = [...new Set([...(topic.tags || []), ...items.flatMap((i) => i.terms.slice(0, 2))])].slice(0, 8);
  const fm = `---\ntitle: "${topic.name} — ${date}"\ndate: ${date}\ndraft: ${STATUS === 'draft'}\ntags: [${tags.join(', ')}]\nsources: ${items.length}\n---\n`;

  const intro = `This edition covers ${items.length} recent ${items.length === 1 ? 'piece' : 'pieces'} from ${[...new Set(items.map((i) => mdEscape(i.site)))].join(', ')}. Each entry below is a short summary with a link to the original; read the source for the full story.\n`;

  const sections = items.map((it, idx) => {
    const bullets = it.summary.map((s) => `- ${mdEscape(s)}`).join('\n');
    // Short quoted excerpt: use the page description unless it just repeats a key point.
    const excerptSrc = it.description && !it.summary.some((x) => x.startsWith(it.description.slice(0, 40))) ? it.description : '';
    const excerpt = excerptSrc ? clip(excerptSrc, MAX_EXCERPT) : '';
    return [
      `## ${idx + 1}. ${mdEscape(it.title)}`,
      it.image ? `![${mdEscape(it.title)}](${it.image})\n` : '',
      `*${mdEscape(it.site)}${it.author ? ` · ${mdEscape(it.author)}` : ''}${it.date ? ` · ${mdEscape(it.date.slice(0, 10))}` : ''}*\n`,
      `**Key points**\n\n${bullets}\n`,
      excerpt ? `> ${mdEscape(excerpt)}\n` : '',
      `Topics: ${it.terms.map(mdEscape).join(', ')}\n`,
      `[Read the original at ${mdEscape(it.site)} →](${it.url})\n`,
    ].filter(Boolean).join('\n');
  });

  const vars = {
    frontmatter: fm,
    title: topic.name,
    date,
    tags: tags.join(', '),
    intro,
    commentary: commentary ? `## Editor's take\n\n${commentary.trim()}\n` : '',
    items: sections.join('\n---\n\n'),
    sources: items.map((i) => `- [${mdEscape(i.title)}](${i.url}) (${mdEscape(i.site)})`).join('\n'),
  };
  return (template || DEFAULT_TPL).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

const htmlShell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{font:17px/1.65 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}
img{max-width:100%;border-radius:8px}blockquote{border-left:3px solid #888;margin:1rem 0;padding:.2rem 1rem;opacity:.85}
hr{border:0;border-top:1px solid #8884;margin:2rem 0}a{color:#2563eb}</style></head><body>${body}</body></html>`;

// ---------- Publishing ----------
async function postJson(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: timeoutSignal() });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const publishers = {
  // Writes a Markdown file into your Hugo content dir (front matter already Hugo-compatible).
  async hugo(post) {
    const dir = cfg.publish?.hugo?.contentDir || 'content/posts';
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${post.slug}.md`);
    await fs.writeFile(file, post.md);
    return file;
  },
  // Env: WP_USER, WP_APP_PASSWORD (Users > Profile > Application Passwords). Config: publish.wordpress.url
  async wordpress(post) {
    const { url } = cfg.publish?.wordpress || {};
    if (!url || !process.env.WP_USER || !process.env.WP_APP_PASSWORD) throw new Error('need publish.wordpress.url, WP_USER, WP_APP_PASSWORD');
    const auth = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
    const r = await postJson(`${url.replace(/\/$/, '')}/wp-json/wp/v2/posts`, { authorization: `Basic ${auth}` },
      { title: post.title, content: post.html, slug: post.slug, status: STATUS });
    return r.link;
  },
  // Env: GHOST_ADMIN_KEY ("id:secret" from Custom Integrations). Config: publish.ghost.url
  async ghost(post) {
    const { url } = cfg.publish?.ghost || {};
    const key = process.env.GHOST_ADMIN_KEY;
    if (!url || !key) throw new Error('need publish.ghost.url and GHOST_ADMIN_KEY');
    const [id, secret] = key.split(':');
    const b64u = (x) => Buffer.from(x).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }));
    const body = b64u(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' }));
    const sig = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(`${head}.${body}`).digest('base64url');
    const r = await postJson(`${url.replace(/\/$/, '')}/ghost/api/admin/posts/?source=html`, { authorization: `Ghost ${head}.${body}.${sig}` },
      { posts: [{ title: post.title, html: post.html, status: STATUS, tags: post.tags.map((name) => ({ name })) }] });
    return r.posts?.[0]?.url;
  },
};

// ---------- Main ----------
await fs.mkdir(OUT, { recursive: true });
const seen = new Set(JSON.parse(await fs.readFile(SEEN_FILE, 'utf8').catch(() => '[]')));
const built = [];
let publishFailures = 0;
const template = cfg.template ? await fs.readFile(cfg.template, 'utf8') : null;
const globalCommentary = COMMENTARY_FILE ? await fs.readFile(COMMENTARY_FILE, 'utf8') : null;
if (PUBLISH && !publishers[PUBLISH]) { log('unknown --publish target:', PUBLISH); process.exit(1); }

for (const topic of cfg.topics) {
  if (ONLY_TOPIC && topic.name !== ONLY_TOPIC) continue;
  log('topic:', topic.name);
  const items = [];
  const used = []; // marked as seen only once the post is written (and published, with --publish)
  for (const src of topic.sources) {
    let links = [];
    try { links = await discover(src); } catch (e) { log('discover failed', src.url, e.message); }
    for (const url of links) {
      if (seen.has(url) || used.includes(url)) { log('already used, skipping', url); continue; }
      try {
        const html = await fetchHtml(url);
        if (!html) continue;
        const a = extract(html, url);
        if (a.text.length < 400) { log('too little text, skipping', url); continue; }
        items.push({ ...a, summary: summarize(a.text, SUM_N), terms: keyTerms(a.text) });
        used.push(url);
        log('ok', a.title);
      } catch (e) { log('failed', url, e.message); }
    }
  }
  if (!items.length) { log('nothing new for', topic.name); continue; }
  const commentary = globalCommentary
    ?? (topic.commentaryFile ? await fs.readFile(topic.commentaryFile, 'utf8') : topic.commentary) ?? '';
  const md = renderPost(topic, items, commentary, template);
  const base = `${new Date().toISOString().slice(0, 10)}-${slug(topic.name)}`;
  if (DRY) { console.log(md); continue; }
  await fs.writeFile(path.join(OUT, `${base}.md`), md);
  await fs.writeFile(path.join(OUT, `${base}.html`), htmlShell(topic.name, marked.parse(md.replace(/^---[\s\S]*?---\n/, ''))));
  built.push({ name: topic.name, file: `${base}.html` });
  if (PUBLISH) {
    try {
      const bodyHtml = marked.parse(md.replace(/^---[\s\S]*?---\n/, '').replace(/^# .*\n/, ''));
      const tags = (md.match(/^tags: \[(.*)\]$/m)?.[1] || '').split(', ').filter(Boolean);
      const where = await publishers[PUBLISH]({ title: `${topic.name} — ${new Date().toISOString().slice(0, 10)}`, slug: base, md, html: bodyHtml, tags });
      log(`published (${STATUS}) via ${PUBLISH}:`, where);
    } catch (e) {
      // Leave these sources unused so the next run tries again, and exit non-zero so run.sh/cron report it.
      log('publish failed:', e.message);
      publishFailures++;
      continue;
    }
  }
  used.forEach((u) => seen.add(u));
  log('wrote', base);
}

if (!DRY) {
  await fs.writeFile(SEEN_FILE, JSON.stringify([...seen], null, 2));
  const old = (await fs.readdir(OUT)).filter((f) => f.endsWith('.html') && f !== 'index.html').sort().reverse();
  const list = old.map((f) => `<li><a href="${f}">${f.replace('.html', '')}</a></li>`).join('');
  await fs.writeFile(path.join(OUT, 'index.html'), htmlShell('Posts', `<h1>Posts</h1><ul>${list}</ul>`));
}
await browser?.close();
log(`done: ${built.length} post(s)`);
if (publishFailures) { log(`${publishFailures} post(s) failed to publish`); process.exitCode = 1; }
