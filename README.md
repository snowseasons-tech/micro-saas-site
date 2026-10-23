# micro-saas-site

Consulting and custom-build site for [Snow Seasons Technologies](https://snowseasonstech.net): a static site on Cloudflare Pages with one Pages Function that takes project inquiries. Ready-made products are sold separately at [snowseasonstech.store](https://snowseasonstech.store).

## Layout

| Path | What it is |
|---|---|
| `index.html` | Homepage: services, process, work (links to the store), FAQ and the project inquiry form |
| `privacy.html`, `404.html`, `page.css` | Other public pages and their shared stylesheet |
| `functions/api/contact.js` | `POST /api/contact`: emails `CONTACT_TO` with Reply-To set to the sender (honeypot, 5 per IP per hour) |
| `functions/_lib/` | Response helpers and security headers for Functions |
| `api/_lib/` | Shared helpers: `store.js` (Upstash Redis, in-memory for tests) and `mail.js` (Resend) |
| `pages/_headers` | Security headers for static files (copied into `dist/` by the build) |
| `scripts/build-pages.js` | Builds `dist/` from an allowlist of public files |
| `scripts/build-blog.js` | Builds `/blog/` (landing page), `/blog/<slug>/` and `sitemap.xml` from `blog/posts/*.md`, publishing each post once its date has passed |
| `blog/posts/` | Posts exported from MariaDB by the `mariadb-auto-blogger` skill (`.claude/skills/`). Don't edit by hand |
| `functions/blog-img/` | `GET /blog-img/<key>`: 302 to a presigned URL on the private R2 bucket that expires after `BLOG_IMAGE_TTL` seconds |
| `.github/workflows/daily-rebuild.yml` | Calls the Pages deploy hook every morning so scheduled posts go live on their date |
| `tests/` | `node:test` suite |

## Setup

Requires Node 20+.

```sh
npm install
npm test        # runs without any services: the store falls back to memory
npm run lint
```

### Environment variables

Set these in the Cloudflare Pages project (and in `.env.local` for local work, which is gitignored).

| Variable | Purpose |
|---|---|
| `CONTACT_TO` | Inbox that receives inquiries. Without it the form answers 503 and asks visitors to email instead |
| `RESEND_API_KEY`, `MAIL_FROM` | Sends the inquiry email. `MAIL_FROM` must be on a domain verified in Resend |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional: per-IP rate limit for the form. Without them the form still works but isn't rate-limited |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Blog images: a **read-only** R2 token for the private bucket. Without them `/blog-img/` answers 503 |
| `BLOG_IMAGE_TTL` | Optional: lifetime of the signed image links in seconds (default 3600) |

## Blog

Posts are written, scheduled and published with the `mariadb-auto-blogger` Claude Code skill: see `.claude/skills/mariadb-auto-blogger/SKILL.md` for setup (database, R2 images, deploy hook) and the workflow. To preview the blog as of a date: `BLOG_BUILD_TIME=2026-11-02T08:00:00-07:00 npm run build:pages`.

## Deployment

Cloudflare Pages, with build command `npm run build:pages` and output directory `dist`. Functions are picked up from `functions/`. They need the `nodejs_compat` compatibility flag, because `api/_lib/` uses `process.env`. `scripts/build-pages.js` copies only the site pages, `page.css` and `_headers` into `dist/` and renders the blog, so source, scripts, tests and Markdown are never published. Add the `CLOUDFLARE_DEPLOY_HOOK` repository secret (a Pages deploy hook URL) so scheduled posts go live without a push.
