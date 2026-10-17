#!/usr/bin/env python3
"""Step 2 - promote search results to leads.

For every company in data/search_results.csv this picks the most likely official
website, a phone number, and a short description, and adds one row to
data/leads.csv.

Incremental and edit-safe:
  * companies already in leads.csv are never overwritten - only BLANK fields are
    filled in (so your manual fixes and extra columns survive);
  * domain_confidence says how sure the pick is: high / medium / low.
    Step 3 only scrapes medium+ by default, so wrong guesses don't produce
    contacts for the wrong company. Fix a domain by hand and set
    domain_confidence to "manual" to release it for scraping.

Optional: put extra domains to ignore in blocked_domains.txt (one per line).
"""
from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict
from urllib.parse import urlparse

import common as c

# Directories, socials, marketplaces, reference sites: never "the company's own website".
BLOCKED = {
    "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com",
    "tiktok.com", "pinterest.com", "reddit.com", "nextdoor.com", "yelp.com", "yellowpages.com",
    "superpages.com", "whitepages.com", "mapquest.com", "bbb.org", "glassdoor.com", "indeed.com",
    "ziprecruiter.com", "crunchbase.com", "zoominfo.com", "dnb.com", "bloomberg.com",
    "wikipedia.org", "wikidata.org", "manta.com", "opencorporates.com", "tripadvisor.com",
    "apollo.io", "rocketreach.co", "buzzfile.com", "chamberofcommerce.com", "birdeye.com",
    "trustpilot.com", "angi.com", "thumbtack.com", "houzz.com", "amazon.com", "ebay.com",
    "google.com", "bing.com", "duckduckgo.com", "yahoo.com", "apple.com", "play.google.com",
}
NAME_STOP = {"inc", "llc", "ltd", "co", "corp", "corporation", "company", "the", "and", "of",
             "group", "holdings", "limited", "plc", "lp", "llp", "pllc", "gmbh", "sa", "ag", "pc"}


def load_blocked() -> set[str]:
    extra = c.BASE_DIR / "blocked_domains.txt"
    blocked = set(BLOCKED)
    if extra.exists():
        for line in extra.read_text(encoding="utf-8").splitlines():
            line = line.strip().lower()
            if line and not line.startswith("#"):
                blocked.add(line)
    return blocked


def name_tokens(name: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", name.lower().replace("&", " and "))
    return [w for w in words if w not in NAME_STOP]


def is_blocked(host: str, blocked: set[str]) -> bool:
    return any(host == d or host.endswith("." + d) for d in blocked)


def score(r: dict, sig: list[str], joined: str, host_counts: Counter) -> float:
    host = r["host"]
    label = re.sub(r"[^a-z0-9]", "", host.rsplit(".", 1)[0])
    title = (r.get("title") or "").lower()
    s = 0.0
    if sig:
        s += 50 * sum(t in label for t in sig) / len(sig)         # name words in the domain
        s += 15 * sum(t in title for t in sig) / len(sig)         # ...and in the page title
    if joined and joined in label:
        s += 20                                                   # whole name in the domain
    try:
        rank = int(r.get("rank") or 10)
    except ValueError:
        rank = 10
    s += max(0, 12 - rank)                                        # search ranking
    s += min(9, 3 * (host_counts[host] - 1))                      # host appears repeatedly
    path = urlparse(r["url"]).path.strip("/")
    s += 4 if not path else 2 if "/" not in path else 0           # homepage-ish URLs
    return s


def pick_site(company: str, results: list[dict], blocked: set[str]) -> dict | None:
    tokens = name_tokens(company)
    sig = [t for t in tokens if len(t) >= 3] or tokens
    joined = "".join(tokens)
    cands = [r for r in results if r["host"] and not is_blocked(r["host"], blocked)]
    if not cands:
        return None
    counts = Counter(r["host"] for r in cands)
    best = max(cands, key=lambda r: score(r, sig, joined, counts))
    s = score(best, sig, joined, counts)
    p = urlparse(best["url"])
    return {
        "domain": best["host"],
        "website": f"{p.scheme}://{p.netloc}/",
        "title": c.safe_text(best.get("title"))[:120],
        "description": c.safe_text(best.get("snippet"))[:300],
        "source_url": best["url"],
        "domain_confidence": "high" if s >= 60 else "medium" if s >= 35 else "low",
    }


def pick_phone(company: str, results: list[dict], site_host: str | None) -> str:
    """Most common phone among snippets that are about this company."""
    norm = " ".join(name_tokens(company))
    found: list[str] = []
    for r in results:
        text = f"{r.get('title', '')} {r.get('snippet', '')}"
        about_company = r["host"] == site_host or (
            norm and norm in " ".join(re.findall(r"[a-z0-9]+", text.lower())))
        if about_company:
            found += c.find_phones(text)
    return Counter(found).most_common(1)[0][0] if found else ""


def main() -> int:
    results = c.read_csv(c.SEARCH_RESULTS)
    if not results and not c.read_csv(c.SEARCH_LOG):
        c.log("build: no search results yet - nothing to do")
        return 0

    grouped: dict[str, list[dict]] = defaultdict(list)
    display: dict[str, str] = {}
    for r in results:
        key = c.company_key(r["company"])
        grouped[key].append(r)
        display.setdefault(key, r["company"])

    # Companies that were searched OK but returned nothing still get a lead row
    # (status 'no_domain') so they show up for review instead of silently vanishing.
    for r in c.read_csv(c.SEARCH_LOG):
        if r.get("ok") == "1":
            key = c.company_key(r["company"])
            grouped.setdefault(key, [])
            display.setdefault(key, r["company"])

    blocked = load_blocked()
    leads = c.read_csv(c.LEADS)
    index = {c.company_key(l["company"]): l for l in leads}
    added = filled = 0

    for key, rs in grouped.items():
        rs.sort(key=lambda r: int(r["rank"]) if str(r.get("rank", "")).isdigit() else 99)
        site = pick_site(display[key], rs, blocked)
        lead = index.get(key)
        if lead is None:
            lead = {f: "" for f in c.LEAD_FIELDS}
            lead.update(company=display[key], created_at=c.now(),
                        status="new" if site else "no_domain")
            if site:
                lead.update(site)
            lead["phone"] = pick_phone(display[key], rs, site["domain"] if site else None)
            leads.append(lead)
            index[key] = lead
            added += 1
            continue
        changed = False
        if site and not lead.get("domain"):
            for k, v in site.items():
                if not lead.get(k):
                    lead[k] = v
            if lead.get("status", "") in ("", "no_domain"):
                lead["status"] = "new"
            changed = True
        if not lead.get("phone"):
            phone = pick_phone(display[key], rs, lead.get("domain") or None)
            if phone:
                lead["phone"] = phone
                changed = True
        filled += changed

    if added or filled:
        c.write_csv_atomic(c.LEADS, c.LEAD_FIELDS, leads)

    low = sum(1 for l in leads if l.get("domain") and l.get("domain_confidence") == "low")
    nodom = sum(1 for l in leads if not l.get("domain"))
    c.log(f"build: {len(grouped)} searched companies -> {added} new leads, {filled} existing leads "
          f"filled in; {len(leads)} leads total")
    if low or nodom:
        c.log(f"build: needs your review: {low} low-confidence domain(s), {nodom} with no domain "
              f"(edit data/leads.csv; set domain_confidence to 'manual' after fixing)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
