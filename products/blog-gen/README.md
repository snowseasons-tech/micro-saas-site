# blogen

Scrape-only blog roundup generator. No APIs, no LLMs, no per-run cost.

    npm install
    # optional, for JS-rendered sites:
    npx playwright install chromium
    node blogen.mjs --dry                 # preview to stdout
    node blogen.mjs                       # writes out/*.md, out/*.html, out/index.html
    node blogen.mjs --topic "Node.js Weekly Roundup" --browser

Edit `sources.json`: modes are `feed` (RSS/Atom), `index` (listing page + CSS `linkSelector`), `page` (single URL).

Built-in guardrails: robots.txt respected, rate limiting (`delayMs`), dedupe via `out/.seen.json`,
summaries + short capped excerpts + attribution links instead of copying full text.

Cron: `0 7 * * 1 cd /path/blogen && node blogen.mjs`

## Commentary, template, publishing

- `template.md` controls layout. Placeholders: `{{frontmatter}} {{title}} {{date}} {{tags}} {{intro}} {{commentary}} {{items}} {{sources}}`.
- Commentary: per topic via `commentary` (string) or `commentaryFile`, or globally with `--commentary file.md`. It renders as an "Editor's take" section where `{{commentary}}` sits.
- Publish: `--publish hugo|wordpress|ghost`. Everything posts as a **draft** unless you pass `--live`.
  - hugo: writes `publish.hugo.contentDir/<slug>.md`
  - wordpress: `publish.wordpress.url` + env `WP_USER`, `WP_APP_PASSWORD`
  - ghost: `publish.ghost.url` + env `GHOST_ADMIN_KEY` (`id:secret`)
  - Put env vars in `.env` next to `run.sh` (it's sourced automatically).
- Scheduling: `./run.sh --install-cron "0 7 * * 1" --publish ghost` (lockfile, per-run logs, 30-day log cleanup).
