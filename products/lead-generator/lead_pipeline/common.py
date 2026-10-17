"""Shared helpers for the lead pipeline scripts (paths, CSV I/O, small utilities)."""
from __future__ import annotations

import csv
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(os.environ.get("PROJECT_DIR") or Path(__file__).resolve().parent)
DATA_DIR = Path(os.environ.get("DATA_DIR") or BASE_DIR / "data")

SEARCH_RESULTS = DATA_DIR / "search_results.csv"   # step 1 output (raw search hits)
SEARCH_LOG = DATA_DIR / "search_log.csv"           # step 1 bookkeeping (what was searched, when)
LEADS = DATA_DIR / "leads.csv"                     # step 2 output, step 3 updates status here
CONTACTS = DATA_DIR / "contacts.csv"               # step 3 output

LEAD_FIELDS = [
    "company", "domain", "website", "phone", "title", "description",
    "domain_confidence", "source_url", "status", "created_at",
    "scraped_at", "scrape_status", "scrape_attempts",
]
CONTACT_FIELDS = [
    "company", "domain", "email", "email_type", "same_domain",
    "name", "title", "phone", "source_url", "scraped_at",
]


def log(msg: str) -> None:
    print(msg, flush=True)


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def company_key(name: str) -> str:
    """Normalised identity for a company name ('Acme, Inc.' == 'acme inc')."""
    return re.sub(r"[^\w&]+", " ", (name or "").lower()).strip()


def host_of(url: str) -> str:
    """Lower-case hostname without a leading 'www.'; '' if unparseable."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def safe_text(s: str | None) -> str:
    """Collapse whitespace and defuse spreadsheet formula injection in scraped text."""
    s = " ".join((s or "").split())
    return "'" + s if s[:1] in ("=", "+", "-", "@") else s


# ---- phones (US/NANP formats; see README to extend) --------------------------
PHONE_RE = re.compile(
    r"(?<![\d.])(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})(?:\)\s*|[\s.\-])([2-9]\d{2})[\s.\-](\d{4})(?!\d)"
)


def find_phones(text: str) -> list[str]:
    return [f"({a}) {b}-{d}" for a, b, d in PHONE_RE.findall(text or "")]


def format_phone(raw: str) -> str:
    raw = (raw or "").strip()
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    if 7 <= len(digits) <= 15:
        return ("+" if raw.startswith("+") else "") + digits
    return ""


# ---- CSV ---------------------------------------------------------------------
def read_csv(path: Path) -> list[dict]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [{k: (v or "") for k, v in row.items() if k is not None}
                for row in csv.DictReader(f)]


def write_csv_atomic(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    """Rewrite a CSV atomically. Extra columns found in rows (e.g. ones you added
    by hand in a spreadsheet) are preserved after the standard columns."""
    cols = list(fieldnames)
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=cols, restval="")
            w.writeheader()
            w.writerows(rows)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def append_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists() or path.stat().st_size == 0
    cols = list(fieldnames)
    if not new:  # respect whatever header is already there
        with open(path, newline="", encoding="utf-8-sig") as f:
            header = next(csv.reader(f), None)
        if header:
            cols = header
    with open(path, "a", newline="", encoding="utf-8-sig" if new else "utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, restval="", extrasaction="ignore")
        if new:
            w.writeheader()
        w.writerows(rows)
