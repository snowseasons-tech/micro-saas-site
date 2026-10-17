#!/usr/bin/env python3
"""Step 1 - search the web for each company name and store the raw results.

Called by run_pipeline.sh as:
    company_web_search.py --file NAMES.txt --max-results N --delay SECONDS

Output (appended, de-duplicated):  data/search_results.csv
Bookkeeping:                       data/search_log.csv

Exit code 0 = every name was searched (or was searched recently and skipped).
Exit code 1 = at least one search failed. run_pipeline.sh then leaves the whole
batch in the queue; the next run skips names that already succeeded, so a retry
only repeats the failures.
"""
from __future__ import annotations

import argparse
import os
import random
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import urlparse

import common as c

try:  # `pip install ddgs` (formerly duckduckgo_search)
    from ddgs import DDGS
except ImportError:
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        DDGS = None

RESULT_FIELDS = ["company", "rank", "title", "url", "host", "snippet", "searched_at"]
LOG_FIELDS = ["company", "searched_at", "ok", "n_results", "error"]
ATTEMPTS = 3        # tries per company before it counts as failed
ABORT_AFTER = 5     # consecutive failed companies => assume we're blocked, stop


def load_names(path: str) -> list[str]:
    names, seen = [], set()
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            key = c.company_key(name)
            if key and key not in seen:
                seen.add(key)
                names.append(name)
    return names


def web_search(query: str, max_results: int, region: str) -> list[dict]:
    try:
        raw = DDGS().text(query, region=region, max_results=max_results)
    except Exception as e:  # ddgs raises when a query simply has no hits
        if "no results" in str(e).lower():
            return []
        raise
    out = []
    for r in raw or []:
        url = (r.get("href") or r.get("url") or "").strip()
        if urlparse(url).scheme not in ("http", "https"):
            continue
        out.append({"title": r.get("title") or "", "url": url, "snippet": r.get("body") or ""})
    return out


def recently_searched(days: int) -> set[str]:
    cutoff = datetime.now() - timedelta(days=days)
    done = set()
    for r in c.read_csv(c.SEARCH_LOG):
        if r.get("ok") != "1":
            continue
        try:
            when = datetime.fromisoformat(r["searched_at"])
        except (ValueError, KeyError):
            continue
        if when >= cutoff:
            done.add(c.company_key(r["company"]))
    return done


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", required=True, help="text file, one company name per line ('#' = comment)")
    ap.add_argument("--max-results", type=int, default=10)
    ap.add_argument("--delay", type=float, default=2.0, help="base seconds between searches (jittered)")
    ap.add_argument("--region", default=os.environ.get("SEARCH_REGION", "us-en"))
    ap.add_argument("--query-suffix", default=os.environ.get("SEARCH_SUFFIX", "official website"),
                    help="words appended to each company name in the query")
    ap.add_argument("--recheck-days", type=int, default=int(os.environ.get("SEARCH_RECHECK_DAYS", "30")),
                    help="skip names successfully searched within this many days")
    ap.add_argument("--force", action="store_true", help="search even if searched recently")
    args = ap.parse_args()

    if DDGS is None:
        c.log("ERROR: search library missing. Run: pip install -r requirements.txt")
        return 2

    names = load_names(args.file)
    if not names:
        c.log("search: no company names in input")
        return 0

    skip = set() if args.force else recently_searched(args.recheck_days)
    todo = [n for n in names if c.company_key(n) not in skip]
    c.log(f"search: {len(names)} names, {len(names) - len(todo)} searched recently (skipped), {len(todo)} to search")

    seen = {(c.company_key(r["company"]), r["url"]) for r in c.read_csv(c.SEARCH_RESULTS)}
    failures = consecutive = new_rows = 0

    for i, name in enumerate(todo):
        query = f"{name} {args.query_suffix}".strip()
        results, err = None, ""
        for attempt in range(1, ATTEMPTS + 1):
            try:
                results = web_search(query, args.max_results, args.region)
                break
            except Exception as e:
                err = f"{type(e).__name__}: {e}".replace("\n", " ")[:200]
                if attempt < ATTEMPTS:
                    wait = max(args.delay, 1.0) * 5 * attempt * random.uniform(0.8, 1.3)
                    c.log(f"  retry {attempt}/{ATTEMPTS - 1} for {name!r} in {wait:.0f}s ({err})")
                    time.sleep(wait)

        stamp = c.now()
        if results is None:
            failures += 1
            consecutive += 1
            c.append_csv(c.SEARCH_LOG, LOG_FIELDS, [{"company": name, "searched_at": stamp, "ok": "0",
                                                    "n_results": "0", "error": err}])
            c.log(f"  [{i + 1}/{len(todo)}] FAILED {name!r}: {err}")
            if consecutive >= ABORT_AFTER:
                left = len(todo) - i - 1
                failures += left
                c.log(f"search: {ABORT_AFTER} failures in a row (rate-limited or blocked?) - "
                      f"stopping, {left} name(s) not attempted")
                break
        else:
            consecutive = 0
            rows = []
            for rank, r in enumerate(results, 1):
                key = (c.company_key(name), r["url"])
                if key in seen:
                    continue
                seen.add(key)
                rows.append({"company": name, "rank": rank, "title": c.safe_text(r["title"]),
                             "url": r["url"], "host": c.host_of(r["url"]),
                             "snippet": c.safe_text(r["snippet"]), "searched_at": stamp})
            c.append_csv(c.SEARCH_RESULTS, RESULT_FIELDS, rows)
            c.append_csv(c.SEARCH_LOG, LOG_FIELDS, [{"company": name, "searched_at": stamp, "ok": "1",
                                                    "n_results": str(len(results)), "error": ""}])
            new_rows += len(rows)
            c.log(f"  [{i + 1}/{len(todo)}] {name!r}: {len(results)} results ({len(rows)} new)")

        if i < len(todo) - 1:
            time.sleep(args.delay * random.uniform(0.75, 1.5))

    c.log(f"search: done - {new_rows} new result rows, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
