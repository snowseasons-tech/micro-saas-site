---
name: mariadb-auto-blogger
description: "Write, schedule and publish Snow Seasons Tech blog posts (snowseasonstech.net/blog) from MariaDB, with images on private R2 behind expiring signed links and health checks of the live site. Use whenever the user wants to add, import, edit, schedule, reschedule, unpublish or archive a blog post or article for snowseasonstech.net, upload a blog image, see what's scheduled, export posts to the site, check that blog posts and images are live (or why one is a 404), or set up the blog's database, R2 images or daily rebuild. Use it even if they just say 'blog' or 'article' while working in this repo."
---

# mariadb-auto-blogger

Blog posts live in MariaDB, which is the source of truth. `blogger.py export` writes the scheduled ones to `blog/posts/*.md` in this repo. The site build (`scripts/build-blog.js`) publishes each one once its date has passed, and a daily GitHub Action rebuilds Cloudflare Pages at 6:30 AM MST / 7:30 AM MDT. So a post scheduled for 6:00 AM goes live that morning without anyone running anything. Images sit in a **private** R2 bucket. Pages link to `/blog-img/<key>`, and that Pages Function redirects to a presigned R2 URL that **expires after an hour** (`BLOG_IMAGE_TTL`).

Run everything from the repo root. `uv` installs the script's two dependencies on first run:

```bash
B=.claude/skills/mariadb-auto-blogger/scripts/blogger.py
uv run $B list
```

## Commands

| Command | What it does |
|---|---|
| `init` | Creates `blog_posts`, `blog_images` and `blog_checks` if they're missing. Never changes existing data |
| `import FILE.md ...` | Adds drafts. Front matter: `title`, `description`, `keywords`, `author`, `slug` (otherwise the slug comes from the file name). Existing slugs are skipped |
| `list` | Every post with its status, date, and whether `blog/posts/` is up to date |
| `schedule SLUG 2026-11-02` | Schedules for 6:00 AM Mountain, or give a time: `2026-11-02T09:30` |
| `unschedule SLUG` / `archive SLUG` | Back to draft / off the site. Either way, export afterwards |
| `add-image SLUG FILE --alt "..." [--replace /old/path.png]` | Uploads to R2 as `blog/<slug>/<hash>.<ext>` and swaps the old reference in the post |
| `export [--dry-run]` | Writes `blog/posts/` for scheduled and published posts, and removes files for drafts and archived posts |
| `check [--live]` | Builds the site locally and checks that due posts are built, future ones aren't, and that links, images and exports are right. `--live` also fetches the real site (read-only): each due post, the landing page, and every image's redirect plus its signed URL. A passing live check marks the post `published`. Results go in `blog_checks` |

To edit a post's text, update `blog_posts.body` (or title or description) in MariaDB. A quick way is to write the Markdown to a file and run an `UPDATE` with Python and pymysql. Then export. MariaDB is the source of truth, so never edit `blog/posts/*.md` by hand; the next export overwrites it.

## Workflow

1. **Draft:** run `import` for Markdown files, or insert the row directly. Read the post back and fix anything obviously broken.
2. **Images:** posts may only use `/blog-img/...` images. The site's CSP blocks other hosts, and `check` flags them. For every `![..](/assets/...)` that `import` reports, ask the user for the image file, then run `add-image ... --replace`. If there's no image, remove the reference rather than publishing a broken one.
3. **Schedule:** confirm the date with the user. Mondays at 6:00 AM Mountain work well, since the daily rebuild at 6:30/7:30 then publishes it. Run `schedule`.
4. **Export and check:** run `export`, then `check`. Fix every FAIL before going on. To preview a date: `BLOG_BUILD_TIME=2026-11-02T08:00:00-07:00 npm run build:pages`, then open `dist/blog/`.
5. **Ship:** show the user `git diff --stat` and the posts going out with their dates, then **ask before committing and pushing**. Pushing deploys the site, and posts whose date has passed go live right away. Commit the `blog/posts/` changes with a message naming the posts.
6. **After the date:** run `check --live`. If the live site isn't serving the blog (wrong project on the domain, failed deploy), say exactly what's wrong instead of retrying.

Future-dated posts are committed to a **public** GitHub repo (snowseasons-tech/micro-saas-site), so their text is readable there before the publish date. Mention that if the user has anything embargoed.

## Setup (once)

**Database.** Config is read from `~/.config/mariadb-auto-blogger/.env` (keep it chmod 600), then from `.env.local` in the repo (gitignored), then from environment variables:

```
BLOG_DB_HOST=127.0.0.1
BLOG_DB_PORT=3306
BLOG_DB_USER=...
BLOG_DB_PASSWORD=...
BLOG_DB_NAME=postbox        # any database the user can create tables in; the tables are prefixed blog_
BLOG_SITE_URL=https://snowseasonstech.net
BLOG_TZ=America/Denver
```

Then run `uv run $B init`.

**Images (R2).**
1. In Cloudflare go to R2 > Create bucket (for example `snowseasons-media`). Keep it **private**, with no public access or custom domain.
2. Create two API tokens, both limited to that bucket:
   - **Object Read & Write**, for uploads from this machine: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` in `~/.config/mariadb-auto-blogger/.env`.
   - **Object Read only**, for the site: the same four variables as **encrypted** environment variables in the Cloudflare Pages project (Settings > Variables and Secrets).
3. Optionally set `BLOG_IMAGE_TTL` (seconds, default 3600) in Pages.
4. Don't add a lifecycle rule for `blog/`. Blog images are permanent; only the links expire. If the bucket is shared with Postbox, keep Postbox's lifecycle rule scoped to its `postbox/` prefix.

**Daily rebuild.** In the Cloudflare Pages project go to Settings > Builds > Deploy hooks > Add (branch `main`). Save the URL as the GitHub repository secret `CLOUDFLARE_DEPLOY_HOOK`. Workflow: `.github/workflows/daily-rebuild.yml`. Test it from the Actions tab with "Run workflow". GitHub pauses scheduled workflows after 60 days with no commits, so check the Actions tab if the blog goes quiet for a while.

## Tests

```bash
npm test                                                             # site build, blog pages, /blog-img signing
uv run --with pytest --with pymysql --with python-dotenv pytest .claude/skills/mariadb-auto-blogger/scripts -q
```

The Python tests use the configured database inside a transaction that's rolled back, and never call R2 or the live site.
