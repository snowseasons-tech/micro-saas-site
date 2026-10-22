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

## Deployment

Cloudflare Pages, with build command `npm run build:pages` and output directory `dist`. Functions are picked up from `functions/`. They need the `nodejs_compat` compatibility flag, because `api/_lib/` uses `process.env`. `scripts/build-pages.js` copies only the site pages, `page.css` and `_headers` into `dist/`, so source, scripts, tests and Markdown are never published.
