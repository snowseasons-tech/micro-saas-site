#!/usr/bin/env python3
"""Step 3 - pull emails, names and job titles from lead websites.

Called by run_pipeline.sh as:
    scrape_contacts.py --limit N --delay SECONDS

Reads data/leads.csv, scrapes up to --limit leads that haven't been scraped yet,
appends rows to data/contacts.csv, and records the outcome per lead
(scrape_status: ok | no_contacts | blocked | robots_disallowed | error: ...).

Behaviour worth knowing:
  * Honours robots.txt (and Crawl-delay, capped at 10s) and waits --delay seconds
    between requests to the same site. Fetches only the home page plus a handful
    of same-site pages that look like contact / team / about pages.
  * Only leads whose domain_confidence is >= --min-confidence (default: medium,
    env SCRAPE_MIN_CONFIDENCE) are scraped, so a wrong domain guess doesn't give
    you contacts for the wrong company.
  * Network errors are retried on later runs (3 attempts total). To force a
    re-scrape of a lead, clear its scrape_status cell in leads.csv.
  * Progress is saved after every site, so a timeout/kill loses nothing.
  * Set SCRAPER_USER_AGENT to something that identifies you (with contact info).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from urllib import robotparser
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

import common as c

ROBOT_TOKEN = "LeadPipelineBot"
DEFAULT_UA = os.environ.get("SCRAPER_USER_AGENT", "Mozilla/5.0 (compatible; LeadPipelineBot/1.0)")
CONF_RANK = {"low": 0, "medium": 1, "high": 2, "manual": 3}
MAX_ATTEMPTS = 3
MAX_BYTES = 2_000_000
MAX_PEOPLE_PER_SITE = 25


# ---- fetching ----------------------------------------------------------------
class RobotsDisallowed(Exception):
    pass


class FetchError(Exception):
    def __init__(self, msg: str, blocked: bool = False):
        super().__init__(msg)
        self.blocked = blocked


@dataclass
class Page:
    url: str
    status: int
    content: bytes


class Fetcher:
    def __init__(self, ua: str, timeout: float, delay: float):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
            "Accept-Language": "en-US,en;q=0.8",
        })
        self.timeout, self.delay = timeout, delay
        self._robots: dict[str, robotparser.RobotFileParser] = {}
        self._last: dict[str, float] = {}

    def _wait(self, netloc: str, crawl_delay: float = 0.0) -> None:
        last = self._last.get(netloc)
        if last is not None:
            remaining = max(self.delay, crawl_delay) - (time.monotonic() - last)
            if remaining > 0:
                time.sleep(remaining)

    def _rules(self, url: str) -> robotparser.RobotFileParser:
        p = urlparse(url)
        origin = f"{p.scheme}://{p.netloc}"
        if origin not in self._robots:
            rp = robotparser.RobotFileParser()
            self._wait(p.netloc)
            try:
                r = self.session.get(origin + "/robots.txt", timeout=self.timeout)
            except requests.RequestException as e:
                raise FetchError(f"robots.txt unreachable ({type(e).__name__})")
            self._last[p.netloc] = time.monotonic()
            if r.status_code == 200:
                rp.parse(r.text.splitlines())
                rp.modified()
            elif r.status_code >= 500:
                rp.disallow_all = True      # RFC 9309: server error => assume disallowed
            else:
                rp.allow_all = True         # no robots.txt => allowed
            self._robots[origin] = rp
        return self._robots[origin]

    def get(self, url: str) -> Page:
        """GET with manual redirect-following so robots.txt is checked at every hop."""
        for _ in range(6):
            if urlparse(url).scheme not in ("http", "https"):
                raise FetchError("unsupported URL scheme")
            rp = self._rules(url)
            if not rp.can_fetch(ROBOT_TOKEN, url):
                raise RobotsDisallowed(url)
            delay = rp.crawl_delay(ROBOT_TOKEN) or rp.crawl_delay("*")
            netloc = urlparse(url).netloc
            self._wait(netloc, min(float(delay), 10.0) if delay else 0.0)
            try:
                r = self.session.get(url, timeout=self.timeout, stream=True, allow_redirects=False)
            except requests.RequestException as e:
                raise FetchError(type(e).__name__)
            self._last[netloc] = time.monotonic()
            try:
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("Location"):
                    url = urljoin(url, r.headers["Location"])
                    continue
                ctype = r.headers.get("Content-Type", "").lower()
                if r.status_code != 200 or (ctype and "html" not in ctype and "xml" not in ctype):
                    return Page(url, r.status_code, b"")
                data = b""
                for chunk in r.iter_content(65536):
                    data += chunk
                    if len(data) > MAX_BYTES:
                        break
                return Page(url, 200, data)
            except requests.RequestException as e:
                raise FetchError(type(e).__name__)
            finally:
                r.close()
        raise FetchError("too many redirects")


# ---- extraction --------------------------------------------------------------
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
JUNK_TLDS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "css", "js", "woff", "woff2", "ico", "pdf", "mp4"}
JUNK_DOMAINS = {"example.com", "domain.com", "email.com", "yourdomain.com", "yoursite.com",
                "mysite.com", "sentry.io", "wixpress.com"}
JUNK_LOCALS = {"your", "you", "name", "yourname", "email", "user", "username", "example", "test"}
GENERIC_LOCALS = {"info", "contact", "sales", "support", "hello", "hi", "office", "admin", "help",
                  "service", "services", "team", "mail", "enquiries", "inquiries", "hr", "jobs",
                  "careers", "marketing", "billing", "accounts", "press", "media", "webmaster",
                  "reception", "general", "customerservice", "orders", "booking", "bookings"}

TITLE_RE = re.compile(
    r"\b(?:ceo|cfo|coo|cto|cio|cmo|president|vice[- ]president|vp|founder|co-?founder|"
    r"owner|co-?owner|proprietor|partner|principal|chairman|chairwoman|"
    r"chief [a-z ]{2,30} officer|head of [a-z& ]{2,30}|(?:[a-z&]+ ){0,2}(?:director|manager)|"
    r"administrator|superintendent|supervisor|broker|controller)\b", re.I)
NAME_TOKEN_RE = re.compile(r"^(?:[A-Z][A-Za-z'’\-]{1,20}|[A-Z]\.)$")
NAME_STOP = {
    "our", "team", "contact", "about", "us", "meet", "the", "company", "services", "service",
    "home", "read", "more", "learn", "get", "call", "email", "phone", "leadership", "management",
    "staff", "board", "directors", "officers", "executive", "executives", "view", "profile",
    "bio", "careers", "join", "welcome", "free", "quote", "request", "schedule", "book", "now",
    "hours", "location", "address", "privacy", "policy", "terms", "copyright", "rights",
    "reserved", "customer", "sales", "support", "blog", "news", "inc", "llc", "ltd", "and",
}
SPLIT_RE = re.compile(r"\s+-\s+|\s*[,|:•·–—]\s*")
LINK_PRIORITY = [
    (0, ("contact",)),
    (1, ("team", "staff", "people", "leadership", "management", "meet", "directors", "founders")),
    (2, ("about", "who-we-are", "our-story", "company")),
]
SKIP_EXT = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".mp4")
SKIP_PATH_RE = re.compile(r"/(blog|news|press|posts?|category|tag|products?|shop|cart|careers?|jobs)(/|$)")


def decode_cf(hexstr: str) -> str:
    """Decode Cloudflare's email obfuscation (data-cfemail)."""
    try:
        key = int(hexstr[:2], 16)
        return "".join(chr(int(hexstr[i:i + 2], 16) ^ key) for i in range(2, len(hexstr), 2))
    except ValueError:
        return ""


def deobfuscate(text: str) -> str:
    text = re.sub(r"\s*[\[\(\{]\s*at\s*[\]\)\}]\s*", "@", text, flags=re.I)
    return re.sub(r"\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*", ".", text, flags=re.I)


def clean_email(e: str) -> str:
    e = (e or "").strip().strip(".,;:<>()[]").lower()
    if len(e) > 80 or not EMAIL_RE.fullmatch(e):
        return ""
    local, domain = e.rsplit("@", 1)
    if domain.rsplit(".", 1)[-1] in JUNK_TLDS or local in JUNK_LOCALS:
        return ""
    if domain in JUNK_DOMAINS or any(domain.endswith("." + d) for d in JUNK_DOMAINS):
        return ""
    return e


def name_like(s: str) -> str:
    s = (s or "").strip().strip(",;")
    s = re.sub(r"^(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+", "", s)
    s = re.sub(r",?\s+(?:Jr|Sr|II|III|IV|PhD|MD|CPA|Esq)\.?$", "", s)
    toks = s.split()
    if not 2 <= len(toks) <= 4 or not all(NAME_TOKEN_RE.match(t) for t in toks):
        return ""
    if any(t.lower().strip(".") in NAME_STOP for t in toks) or TITLE_RE.search(s):
        return ""
    return s


def page_emails(soup: BeautifulSoup) -> list[str]:
    found: list[str] = []
    for a in soup.find_all("a", href=True):
        h = a["href"]
        if h.lower().startswith("mailto:"):
            found += EMAIL_RE.findall(unquote(h[7:].split("?")[0]))
        elif "email-protection#" in h:
            found.append(decode_cf(h.split("#", 1)[1]))
    for t in soup.find_all(attrs={"data-cfemail": True}):
        found.append(decode_cf(t["data-cfemail"]))
    found += EMAIL_RE.findall(deobfuscate(soup.get_text(" ")))
    out: list[str] = []
    for e in found:
        e = clean_email(e)
        if e and e not in out:
            out.append(e)
    return out


def page_phones(soup: BeautifulSoup) -> list[str]:
    out = []
    for a in soup.select('a[href^="tel:"]'):
        p = c.format_phone(unquote(a["href"][4:]))
        if p and p not in out:
            out.append(p)
    return out


def jsonld_data(soup: BeautifulSoup) -> tuple[list[str], list[dict]]:
    """(emails, people) declared in schema.org JSON-LD blocks."""
    emails: list[str] = []
    people: list[dict] = []

    def walk(n):
        if isinstance(n, list):
            for x in n:
                walk(x)
            return
        if not isinstance(n, dict):
            return
        t = n.get("@type")
        types = t if isinstance(t, list) else [t]
        mail = n.get("email") if isinstance(n.get("email"), str) else ""
        found = EMAIL_RE.findall(unquote(mail))
        if "Person" in types and isinstance(n.get("name"), str):
            people.append({"name": n["name"], "email": found[0] if found else "",
                           "title": n["jobTitle"] if isinstance(n.get("jobTitle"), str) else ""})
        else:
            emails.extend(found)
        for v in n.values():
            if isinstance(v, (list, dict)):
                walk(v)

    for s in soup.find_all("script", type="application/ld+json"):
        try:
            walk(json.loads(s.string or s.get_text() or ""))
        except (ValueError, TypeError):
            continue
    return emails, people


def people_from_text(soup: BeautifulSoup) -> list[dict]:
    """Best-effort: find 'Name, Title' lines or Name/Title on adjacent lines."""
    lines = [" ".join(l.split()) for l in soup.get_text("\n").split("\n")]
    lines = [l for l in lines if l]
    out: list[dict] = []
    for i, line in enumerate(lines):
        if (len(line) > 80 or line.count(" ") > 9 or not line[0].isupper()
                or "@" in line or line.endswith(".") or not TITLE_RE.search(line)):
            continue
        parts = [p for p in SPLIT_RE.split(line) if p.strip()]
        name = title = ""
        if len(parts) >= 2:
            rest = ", ".join(parts[1:])
            lead = ", ".join(parts[:-1])
            if name_like(parts[0]) and TITLE_RE.search(rest):
                name, title = name_like(parts[0]), rest
            elif name_like(parts[-1]) and TITLE_RE.search(lead):
                name, title = name_like(parts[-1]), lead
        if not name and len(line.split()) <= 6:
            for j in (i - 1, i + 1):
                if 0 <= j < len(lines) and name_like(lines[j]):
                    name, title = name_like(lines[j]), line
                    break
        if name:
            out.append({"name": name, "title": title[:80], "email": ""})
    return out


def rank_links(soup: BeautifulSoup, base_url: str) -> list[str]:
    base_host = c.host_of(base_url)
    found: dict[str, int] = {}
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.lower().startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        url = urljoin(base_url, href).split("#")[0]
        p = urlparse(url)
        if p.scheme not in ("http", "https") or c.host_of(url) != base_host:
            continue
        if p.path.lower().endswith(SKIP_EXT) or SKIP_PATH_RE.search(p.path.lower()):
            continue
        if url.rstrip("/") == base_url.rstrip("/"):
            continue
        hay = (p.path + " " + a.get_text(" ")).lower()
        prio = next((n for n, words in LINK_PRIORITY if any(w in hay for w in words)), None)
        if prio is not None and (url not in found or prio < found[url]):
            found[url] = prio
    return [u for u, _ in sorted(found.items(), key=lambda kv: kv[1])]


def scrape_site(fetcher: Fetcher, website: str, max_pages: int) -> dict:
    home = fetcher.get(website)
    if home.status != 200:
        raise FetchError(f"HTTP {home.status}", blocked=home.status in (401, 403, 429))
    emails: dict[str, str] = {}
    people: dict[str, dict] = {}
    phones: list[str] = []

    def ingest(page: Page) -> BeautifulSoup:
        soup = BeautifulSoup(page.content, "html.parser")
        ld_emails, ld_people = jsonld_data(soup)     # before scripts are stripped
        for t in soup(["script", "style", "noscript"]):
            t.decompose()
        for e in ld_emails + page_emails(soup):
            e = clean_email(e)
            if e:
                emails.setdefault(e, page.url)
        for p in ld_people + people_from_text(soup):
            name = name_like(p["name"])
            if name and name.lower() not in people and len(people) < MAX_PEOPLE_PER_SITE:
                email = clean_email(p.get("email", ""))
                if email:
                    emails.setdefault(email, page.url)
                people[name.lower()] = {"name": name, "title": p.get("title", ""),
                                        "email": email, "source_url": page.url}
        for ph in page_phones(soup):
            if ph not in phones:
                phones.append(ph)
        return soup

    home_soup = ingest(home)
    queue = rank_links(home_soup, home.url)[: max_pages - 1]
    if not queue:
        queue = [urljoin(home.url, "/contact"), urljoin(home.url, "/about")][: max_pages - 1]
    pages = 1
    for url in queue:
        try:
            page = fetcher.get(url)
        except (FetchError, RobotsDisallowed):
            continue
        if page.status == 200:
            ingest(page)
            pages += 1
    return {"emails": emails, "people": people, "phones": phones, "pages": pages}


# ---- turning scraped data into rows -----------------------------------------
def same_domain(email_domain: str, lead_domain: str) -> bool:
    return (email_domain == lead_domain or email_domain.endswith("." + lead_domain)
            or lead_domain.endswith("." + email_domain))


def pairs_with(person: dict, email: str) -> bool:
    if person["email"] == email:
        return True
    toks = [re.sub(r"[^a-z]", "", t.lower()) for t in person["name"].split()]
    toks = [t for t in toks if t]
    if len(toks) < 2:
        return False
    first, last = toks[0], toks[-1]
    local = re.sub(r"[^a-z]", "", email.split("@")[0])
    return local in {first, last, first + last, last + first, first[0] + last, first + last[0]}


def build_rows(lead: dict, scraped: dict, stamp: str) -> list[dict]:
    domain = lead["domain"]
    base = {"company": lead["company"], "domain": domain, "phone": "", "scraped_at": stamp}
    people = scraped["people"]
    used: set[str] = set()
    rows = []
    for email, src in scraped["emails"].items():
        local, edomain = email.rsplit("@", 1)
        row = dict(base, email=email, name="", title="", source_url=src,
                   email_type="generic" if local in GENERIC_LOCALS else "personal",
                   same_domain="yes" if same_domain(edomain, domain) else "no")
        for key, p in people.items():
            if key not in used and pairs_with(p, email):
                row.update(name=c.safe_text(p["name"]), title=c.safe_text(p["title"]))
                used.add(key)
                break
        rows.append(row)
    for key, p in people.items():
        if key not in used:
            rows.append(dict(base, email="", email_type="", same_domain="", source_url=p["source_url"],
                             name=c.safe_text(p["name"]), title=c.safe_text(p["title"])))
    return rows


# ---- main --------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=50, help="max leads to scrape this run (0 = no limit)")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between requests to one site")
    ap.add_argument("--max-pages", type=int, default=6, help="max pages fetched per site")
    ap.add_argument("--timeout", type=float, default=15.0, help="per-request timeout, seconds")
    ap.add_argument("--min-confidence", choices=list(CONF_RANK),
                    default=os.environ.get("SCRAPE_MIN_CONFIDENCE", "medium"))
    ap.add_argument("--user-agent", default=DEFAULT_UA)
    args = ap.parse_args()

    leads = c.read_csv(c.LEADS)
    if not leads:
        c.log("scrape: no leads yet - nothing to do")
        return 0

    min_rank = CONF_RANK[args.min_confidence]
    eligible: list[tuple[int, dict]] = []
    waiting = 0
    for lead in leads:
        domain, website = lead.get("domain", "").strip(), lead.get("website", "").strip()
        if website and not re.match(r"https?://", website, re.I):
            website = "https://" + website
        if website and not domain:
            domain = c.host_of(website)
        if domain and not website:
            website = f"https://{domain}/"       # you only had to type the domain
        lead["domain"], lead["website"] = domain, website
        if not domain or not website:
            continue
        if lead.get("status") == "no_domain":
            lead["status"] = "new"
        status = lead.get("scrape_status", "")
        attempts = int(lead["scrape_attempts"]) if lead.get("scrape_attempts", "").isdigit() else 0
        retry = status.startswith("error") and attempts < MAX_ATTEMPTS
        if status and not retry:
            continue
        # a blank confidence means you typed the domain yourself, so trust it
        if CONF_RANK.get((lead.get("domain_confidence") or "manual").lower(), 0) < min_rank:
            waiting += 1
            continue
        eligible.append((1 if status else 0, lead))   # never-tried first, retries after
    todo = [l for _, l in sorted(eligible, key=lambda t: t[0])]
    if args.limit > 0:
        todo = todo[: args.limit]

    c.log(f"scrape: {len(todo)} lead(s) to scrape this run"
          + (f"; {waiting} waiting for review (domain_confidence below '{args.min_confidence}')" if waiting else ""))
    if not todo:
        return 0

    existing = c.read_csv(c.CONTACTS)
    seen = set()
    for r in existing:
        k = c.company_key(r["company"])
        seen.add((k, r["email"].lower()) if r.get("email") else (k, "name:" + r.get("name", "").lower()))

    fetcher = Fetcher(args.user_agent, args.timeout, args.delay)
    n_ok = n_err = n_rows = 0
    for i, lead in enumerate(todo, 1):
        stamp = c.now()
        attempts = int(lead["scrape_attempts"]) if lead.get("scrape_attempts", "").isdigit() else 0
        rows: list[dict] = []
        try:
            scraped = scrape_site(fetcher, lead["website"], args.max_pages)
            rows = build_rows(lead, scraped, stamp)
            status = "ok" if rows else "no_contacts"
            if not lead.get("phone") and scraped["phones"]:
                lead["phone"] = scraped["phones"][0]
        except RobotsDisallowed:
            status = "robots_disallowed"
        except FetchError as e:
            status = "blocked" if e.blocked else f"error: {e}"
        except Exception as e:  # never let one weird page kill the whole run
            status = f"error: {type(e).__name__}: {e}"[:120]

        fresh = []
        for r in rows:
            k = c.company_key(r["company"])
            key = (k, r["email"]) if r["email"] else (k, "name:" + r["name"].lower())
            if key not in seen:
                seen.add(key)
                fresh.append(r)
        c.append_csv(c.CONTACTS, c.CONTACT_FIELDS, fresh)
        n_rows += len(fresh)
        lead.update(scraped_at=stamp, scrape_status=status, scrape_attempts=str(attempts + 1))
        c.write_csv_atomic(c.LEADS, c.LEAD_FIELDS, leads)   # save progress after every site

        if status.startswith("error"):
            n_err += 1
        else:
            n_ok += 1
        c.log(f"  [{i}/{len(todo)}] {lead['company']} ({lead['domain']}): {status}"
              + (f" - {len(fresh)} new contact row(s)" if fresh else ""))
        time.sleep(random.uniform(0.2, 0.6))

    c.log(f"scrape: done - {n_ok} scraped, {n_err} errors, {n_rows} new contact rows")
    if n_err >= 3 and n_ok == 0:
        c.log("scrape: every attempt failed - looks like a network problem")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
