# Nightly lead-gen pipeline

```
companies_queue.txt ──► company_web_search.py ──► data/search_results.csv
                                                      │
                          build_leads.py  ◄───────────┘
                                │
                          data/leads.csv  ──► scrape_contacts.py ──► data/contacts.csv
```

`run_pipeline.sh` runs the three steps in order, with a lock (no overlapping runs),
per-step timeouts, dated logs in `logs/`, and a failure message to cron's `MAILTO`.

## Setup (once)

```bash
cd /path/to/project
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
chmod +x run_pipeline.sh
# add company names to companies_queue.txt, then:
./run_pipeline.sh --dry-run     # see what would run
./run_pipeline.sh               # real run (prints to screen + logs/)
```
`run_pipeline.sh` picks up `.venv/bin/python` automatically. For nightly runs, use the
cron line in the header of `run_pipeline.sh`.

## What each step does

| Step | Reads | Writes | Notes |
|---|---|---|---|
| search | queue snapshot | `search_results.csv`, `search_log.csv` | Retries 3x with backoff; stops after 5 failures in a row (likely rate-limited). Names searched OK in the last 30 days are skipped, so a failed batch retries cheaply. |
| build | search results | `leads.csv` | One row per company: best official domain, phone, description, `domain_confidence`. Skips LinkedIn/Yelp/etc. Never overwrites existing values. |
| scrape | `leads.csv` | `contacts.csv`, updates `scrape_status` on leads | Home page + up to 5 contact/team/about pages per site. Obeys robots.txt. Saves after every site. |

## Reviewing leads (the one manual step)

`build` flags how sure it is about each website. By default **scrape only touches
`medium`/`high`**, so a wrong guess doesn't produce contacts for the wrong company.

- Open `data/leads.csv`, check rows marked `low` (and `no_domain`).
- Fix the `domain` (or just type the `website`), and set `domain_confidence` to `manual`
  (leaving it blank also counts as hand-entered). The next run scrapes it.
- Your edits and any extra columns you add are preserved on every run.
- To re-scrape a lead, clear its `scrape_status` cell.

`scrape_status` values: `ok`, `no_contacts`, `blocked` (403/429), `robots_disallowed`,
`error: ...` (network errors, or a site that used up its 2-minute time limit; retried up to 3
total attempts). `error: interrupted` means the run was killed while scraping that site; it is
retried after the untried leads, like any other error.

## `contacts.csv` columns

`company, domain, email, email_type (generic|personal), same_domain (yes|no), name, title, phone, source_url, scraped_at`

Emails come from `mailto:` links, visible text, `[at]/[dot]` obfuscation, Cloudflare-protected
addresses and schema.org JSON-LD. Names and titles are a **best-effort heuristic**
("Jane Doe, CEO" or name/title on adjacent lines), and an email is attached to a name only
when it plausibly matches (`jane@`, `jdoe@`, `jane.doe@`). Expect some misses and a little noise.

## Settings (environment variables, all optional)

`MAX_RESULTS`, `SEARCH_DELAY`, `SCRAPE_LIMIT`, `SCRAPE_DELAY`, `STEP_TIMEOUT` (see `run_pipeline.sh`), plus:

| Variable | Default | Purpose |
|---|---|---|
| `SCRAPER_USER_AGENT` | `Mozilla/5.0 (compatible; LeadPipelineBot/1.0)` | Set to something identifying you, with contact info |
| `SCRAPE_MIN_CONFIDENCE` | `medium` | `low` scrapes everything |
| `SEARCH_SUFFIX` | `official website` | Words appended to each company in the query |
| `SEARCH_REGION` | `us-en` | Search region |
| `SEARCH_RECHECK_DAYS` | `30` | Don't re-search a name sooner than this |
| `DATA_DIR` | `./data` | Where CSVs live |

Extra domains to ignore as "not the company's own site": one per line in `blocked_domains.txt`.

## Limitations worth knowing

- **Search backend** (`ddgs`) reads public search results without an API key. It's free but
  unofficial and can be rate-limited or change without notice. To use a paid API (Brave, SerpAPI, Bing...),
  replace the body of `web_search()` in `company_web_search.py`; it only has to return
  `[{"title", "url", "snippet"}, ...]`.
- **JavaScript-rendered sites** that build their pages in the browser show up as `no_contacts`; plain HTTP can't see them.
- **Phones** are matched in US/NANP formats. International numbers are only picked up from `tel:` links.
- **Compliance:** the scraper honours robots.txt and rate limits, but what you do with
  the contacts is on you. Cold email is regulated (CAN-SPAM in the US; GDPR/PECR/CASL elsewhere),
  and personal emails of named people are personal data in many jurisdictions.
