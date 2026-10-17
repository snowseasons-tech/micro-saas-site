# micro-saas-site

Storefront for [Snow Seasons Technologies](https://snowseasonstech.net): a static site plus Vercel serverless functions that sell digital products through Stripe Checkout, deliver files from a private S3/R2 bucket, and run a small customer portal.

## How it works

1. A buyer picks a product on the site. `/api/checkout` creates a Stripe Checkout session using a price ID held in server env (never from the browser).
2. Stripe calls `/api/webhook`. The signature is verified and the order is recorded in Upstash Redis. Each event is handled once. The buyer is emailed a link to their order page.
3. The order page (`/success`) polls `/api/order` and offers a download. `/api/download` checks the order and redirects to a 5-minute signed URL in the private bucket (10 downloads per order).
4. Subscribers manage billing from the order page: `/api/portal` emails them a 30-minute link to the Stripe billing portal.
5. Customers with an account (created by an admin) can sign in at the portal and download the apps they're entitled to.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `privacy.html`, `terms.html`, `refund.html`, `success.html`, `cancel.html`, `page.css` | Public site pages |
| `storefront/` | Checkout page and customer portal (`portal.html`, `portal.js`) |
| `api/` | Vercel serverless functions (one file per endpoint) |
| `api/_lib/` | Shared helpers: catalog, Stripe, store (Upstash/in-memory), auth, mail (Resend), fulfilment, SigV4 presigning |
| `scripts/` | Admin scripts: `upload.js` (put a deliverable in the bucket), `add-user.js` (create or update a portal account) |
| `tests/` | `node:test` suite |
| `products/` | Source for the products being sold. Not deployed (see `.vercelignore`); deliverables go to the private bucket |

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/products` | GET | Product names and prices (from Stripe) |
| `/api/checkout` | POST | Create a Checkout session for `{ productId }` |
| `/api/webhook` | POST | Stripe webhook (raw body, signature verified) |
| `/api/order` | GET | `?session_id=` order status for the success page |
| `/api/download` | GET | `?session_id=` signed download URL for a verified order |
| `/api/portal` | POST / GET | POST `{ session_id }` emails a billing portal link; GET `?t=` opens it |
| `/api/login`, `/api/logout`, `/api/me` | POST / POST / GET | Customer portal sign-in (JSON only, `HttpOnly; SameSite=Strict` cookie) |
| `/api/app-download` | GET | `?product=` signed download for a signed-in, entitled account |

## Setup

Requires Node 20+.

```sh
npm install
npm test        # runs without any services: the store falls back to memory
npm run lint
```

### Environment variables

Set these in Vercel (and in `.env.local` for local work, which is gitignored).

| Variable | Purpose |
|---|---|
| `SITE_URL` | Public base URL, e.g. `https://snowseasonstech.net` (used for redirects and email links) |
| `STRIPE_SECRET_KEY` | Stripe secret key. Live keys (`sk_live_`) are refused unless `ALLOW_LIVE=1` |
| `ALLOW_LIVE` | Set to `1` only on the production deployment |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint |
| `STRIPE_AUTOMATIC_TAX` | Optional: `true` enables Stripe Tax on Checkout |
| `PRICE_BOOKSCAN`, … | Stripe Price IDs, one per product (`priceEnv` in `api/_lib/catalog.js`) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Order, session and rate-limit store. Required in production |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Private bucket for deliverables (S3 or Cloudflare R2; region defaults to `auto`) |
| `RESEND_API_KEY`, `MAIL_FROM` | Order and billing portal emails. Without them, emails are skipped and the billing portal link can't be sent |

### Stripe

- Create a webhook endpoint at `<SITE_URL>/api/webhook` for these events:
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`.
- Configure the customer (billing) portal in the Stripe dashboard before offering subscriptions.
- Do everything in test mode first.

## Adding a product

1. Create the product and Price in Stripe, and set its Price ID in a new `PRICE_*` env var.
2. Add an entry to `api/_lib/catalog.js` (`name`, `priceEnv`, `kind`, and `fileKey`/`filename` for downloads).
3. Upload the file to the bucket under that `fileKey`:
   ```sh
   S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
     node scripts/upload.js path/to/file.html <fileKey>
   ```
   Paste the printed sha256 into the catalog entry.

## Portal accounts

```sh
UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… node scripts/add-user.js customer@example.com bookscan
```

The password is read from stdin. Running it again for the same email updates the password and products, and signs out that account's existing sessions.

## Deployment

Deployed on Vercel. Files that shouldn't be public (`products/`, `scripts/`, `tests/`, Markdown) are excluded by `.vercelignore`.
