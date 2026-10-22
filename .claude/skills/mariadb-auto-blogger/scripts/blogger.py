#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pymysql>=1.1", "python-dotenv>=1.0"]
# ///
"""Blog posts in MariaDB, published to the Snow Seasons site on their date.

Run from the site repo root:  uv run .claude/skills/mariadb-auto-blogger/scripts/blogger.py <command>

  init                          create the blog tables (safe to re-run)
  import FILE.md [...]          add Markdown drafts (front matter: title, description, keywords, author, slug)
  list                          every post with status, date and export state
  schedule SLUG WHEN            WHEN = YYYY-MM-DD (6:00 AM) or YYYY-MM-DDTHH:MM, local time
  unschedule SLUG | archive SLUG   back to draft | take it off the site
  add-image SLUG FILE [--alt T] [--replace REF]   upload to private R2; prints the Markdown to use
  export [--dry-run]            write scheduled/published posts to blog/posts/ (the site builds from these)
  check [--live]                health checks: local build, links and images; --live also checks the real site

Config comes from ~/.config/mariadb-auto-blogger/.env, then the repo's .env.local (see the skill's SKILL.md).
"""

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
KEY_RE = re.compile(r"^blog/[a-z0-9]+(?:-[a-z0-9]+)*/[a-f0-9]{16}\.(?:jpg|png|webp|gif)$")
IMG_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
DEFAULT_TIME = time(6, 0)  # before the daily rebuild at 6:30 MST / 7:30 MDT


# Config and database

def load_config(repo):
    from dotenv import dotenv_values
    cfg = {}
    for f in (Path.home() / ".config/mariadb-auto-blogger/.env", Path(repo) / ".env.local"):
        if f.exists():
            cfg.update({k: v for k, v in dotenv_values(f).items() if v is not None})
    cfg.update({k: v for k, v in os.environ.items() if k.startswith(("BLOG_", "R2_"))})
    return cfg


def tz(cfg):
    return ZoneInfo(cfg.get("BLOG_TZ") or "America/Denver")


def db_error(e):
    code = e.args[0] if e.args and isinstance(e.args[0], int) else None
    return {
        2003: "Can't reach MariaDB. Is it running? (sudo systemctl start mariadb)",
        2002: "Can't reach MariaDB. Is it running? (sudo systemctl start mariadb)",
        1045: "MariaDB rejected the login. Check BLOG_DB_USER and BLOG_DB_PASSWORD.",
        1044: "That user can't use BLOG_DB_NAME. Grant it access, or point BLOG_DB_NAME at a database it can use.",
        1049: "BLOG_DB_NAME doesn't exist. Create it, or use an existing database such as postbox.",
        1146: "The blog tables are missing. Run: blogger.py init",
    }.get(code, f"Database error: {e}")


def connect(cfg):
    import pymysql
    from pymysql.cursors import DictCursor
    missing = [k for k in ("BLOG_DB_USER", "BLOG_DB_NAME") if not cfg.get(k)]
    if missing:
        sys.exit(f"Set {', '.join(missing)} in ~/.config/mariadb-auto-blogger/.env (see SKILL.md).")
    try:
        return pymysql.connect(host=cfg.get("BLOG_DB_HOST", "127.0.0.1"), port=int(cfg.get("BLOG_DB_PORT", "3306")),
                               user=cfg["BLOG_DB_USER"], password=cfg.get("BLOG_DB_PASSWORD", ""),
                               database=cfg["BLOG_DB_NAME"], charset="utf8mb4", cursorclass=DictCursor, autocommit=False)
    except pymysql.MySQLError as e:
        sys.exit(db_error(e))


def get_post(cur, slug):
    cur.execute("SELECT * FROM blog_posts WHERE slug=%s", (slug,))
    p = cur.fetchone()
    if not p:
        raise SystemExit(f"No post with slug {slug!r}. See: blogger.py list")
    return p


# Markdown files

def parse_markdown(text, fallback_slug=""):
    """Front matter (simple key: value lines) and body. Quotes around values are optional."""
    meta, body = {}, text
    m = re.match(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", text, re.S)
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            kv = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
            if kv:
                v = kv.group(2).strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = json.loads(v) if v[0] == '"' else v[1:-1]
                meta[kv.group(1).lower()] = v
    if not meta.get("title"):
        h = re.search(r"^# (.+)$", body, re.M)
        meta["title"] = h.group(1).strip() if h else ""
    meta["slug"] = slugify(meta.get("slug") or fallback_slug or meta["title"])
    return meta, body.strip() + "\n"


def slugify(s):
    s = re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)[:80].strip("-")


def export_text(p, zone):
    """The file the site builds from. Stable for unchanged posts, so re-exporting makes no git noise."""
    when = p["publish_at"].replace(tzinfo=zone).isoformat()
    lines = ["---", f"title: {json.dumps(p['title'], ensure_ascii=False)}", f"slug: {p['slug']}", f"date: {when}"]
    for k in ("description", "keywords", "author"):
        if p.get(k):
            lines.append(f"{k}: {json.dumps(p[k], ensure_ascii=False)}")
    return "\n".join(lines + ["---", "", p["body"].rstrip() + "\n"])


def parse_when(s):
    try:
        if "T" in s or " " in s.strip():
            return datetime.fromisoformat(s.replace(" ", "T")[:16])
        return datetime.combine(datetime.strptime(s, "%Y-%m-%d").date(), DEFAULT_TIME)
    except ValueError:
        raise SystemExit(f"Can't read the date {s!r}. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.") from None


# R2 (S3 API) presigned requests

def presign(method, host, path, access_key, secret_key, region="auto", expires=300, now=None):
    now = now or datetime.now(timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    scope = f"{day}/{region}/s3/aws4_request"
    q = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": f"{access_key}/{scope}", "X-Amz-Date": amz,
         "X-Amz-Expires": str(expires), "X-Amz-SignedHeaders": "host"}
    enc = lambda v: quote(str(v), safe="-_.~")  # noqa: E731
    qs = "&".join(f"{enc(k)}={enc(v)}" for k, v in sorted(q.items()))
    uri = quote(path, safe="/-_.~")
    creq = "\n".join([method, uri, qs, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"])
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(creq.encode()).hexdigest()])
    k = ("AWS4" + secret_key).encode()
    for part in (day, region, "s3", "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    return f"https://{host}{uri}?{qs}&X-Amz-Signature={hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()}"


def r2_put(cfg, key, data, mime, opener=urllib.request.urlopen):
    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET") if not cfg.get(k)]
    if missing:
        raise SystemExit(f"Set {', '.join(missing)} (an R2 token with Object Read & Write on the bucket). See SKILL.md.")
    url = presign("PUT", f"{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com", f"/{cfg['R2_BUCKET']}/{key}",
                  cfg["R2_ACCESS_KEY_ID"], cfg["R2_SECRET_ACCESS_KEY"])
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable"})
    try:
        opener(req, timeout=60).close()
    except urllib.error.HTTPError as e:
        code = re.search(rb"<Code>(\w+)</Code>", e.read() or b"")
        raise SystemExit(f"R2 refused the upload ({e.code} {code.group(1).decode() if code else ''}). "
                         "Check the R2_ keys and that the token can write to the bucket.") from None
    except urllib.error.URLError as e:
        raise SystemExit(f"Couldn't reach R2: {e.reason}") from None


# Commands

def cmd_init(cfg, conn, args):
    sql = (HERE / "schema.sql").read_text()
    with conn.cursor() as cur:
        for stmt in re.findall(r"^CREATE TABLE IF NOT EXISTS .*?\n\);", sql, re.S | re.M):
            cur.execute(stmt)
    conn.commit()
    print("Blog tables are ready.")


def cmd_import(cfg, conn, args):
    with conn.cursor() as cur:
        for f in args.files:
            path = Path(f)
            meta, body = parse_markdown(path.read_text(encoding="utf-8"), path.stem)
            if not meta["title"] or not SLUG_RE.match(meta["slug"]):
                print(f"skip {f}: needs a title")
                continue
            cur.execute("SELECT id FROM blog_posts WHERE slug=%s", (meta["slug"],))
            if cur.fetchone():
                print(f"skip {f}: {meta['slug']} is already in the database")
                continue
            cur.execute("INSERT INTO blog_posts (slug, title, description, keywords, author, body) VALUES (%s,%s,%s,%s,%s,%s)",
                        (meta["slug"], meta["title"][:200], meta.get("description", "")[:400], meta.get("keywords", "")[:400],
                         (meta.get("author") or "Snow Seasons Technologies")[:120], body))
            print(f"added draft {meta['slug']}")
            for alt, ref in re.findall(r"!\[([^\]]*)\]\(([^)\s]+)\)", body):
                if not ref.startswith("/blog-img/"):
                    print(f"  image {ref} isn't hosted yet: blogger.py add-image {meta['slug']} <file> --replace {ref}")
    conn.commit()


def cmd_list(cfg, conn, args):
    repo, zone = Path(args.repo), tz(cfg)
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM blog_posts ORDER BY status='archived', COALESCE(publish_at, '9999-12-31'), slug")
        rows = cur.fetchall()
    if not rows:
        print("No posts yet. Add some with: blogger.py import FILE.md")
    for p in rows:
        when = f"{p['publish_at']:%a %b %d %Y %H:%M}" if p["publish_at"] else "-"
        state = ""
        if p["status"] in ("scheduled", "published"):
            f = repo / "blog/posts" / f"{p['slug']}.md"
            state = "not exported" if not f.exists() else ("export out of date" if f.read_text() != export_text(p, zone) else "exported")
        print(f"{p['status']:<10} {when:<22} {p['slug']:<48} {state}")


def set_status(conn, slug, status, publish_at=None):
    with conn.cursor() as cur:
        p = get_post(cur, slug)
        cur.execute("UPDATE blog_posts SET status=%s, publish_at=COALESCE(%s, publish_at) WHERE id=%s",
                    (status, publish_at, p["id"]))
    conn.commit()


def cmd_schedule(cfg, conn, args):
    when = parse_when(args.when)
    set_status(conn, args.slug, "scheduled", when)
    late = when <= datetime.now(tz(cfg)).replace(tzinfo=None)
    print(f"{args.slug} scheduled for {when:%a %b %d %Y %H:%M} {tz(cfg).key}"
          + (" (already past, so it goes live on the next deploy)" if late else "") + ". Run export, then commit and push.")


def cmd_unschedule(cfg, conn, args):
    set_status(conn, args.slug, "draft")
    print(f"{args.slug} is a draft again. Run export to take it out of blog/posts/.")


def cmd_archive(cfg, conn, args):
    set_status(conn, args.slug, "archived")
    print(f"{args.slug} archived. Run export, then commit and push, to take it off the site.")


def cmd_add_image(cfg, conn, args, opener=urllib.request.urlopen):
    path = Path(args.file)
    data = path.read_bytes()
    mime = mimetypes.guess_type(path.name)[0] or ""
    if mime not in IMG_TYPES:
        raise SystemExit(f"{path.name}: use a JPEG, PNG, WebP or GIF image.")
    if len(data) > 10 * 1024 * 1024:
        raise SystemExit(f"{path.name} is {len(data) // 1048576} MB; keep blog images under 10 MB (ideally under 500 KB).")
    with conn.cursor() as cur:
        p = get_post(cur, args.slug)
        key = f"blog/{p['slug']}/{hashlib.sha256(data).hexdigest()[:16]}{IMG_TYPES[mime]}"
        cur.execute("SELECT id FROM blog_images WHERE r2_key=%s", (key,))
        if not cur.fetchone():
            r2_put(cfg, key, data, mime, opener)
            cur.execute("INSERT INTO blog_images (post_id, r2_key, alt, mime, bytes) VALUES (%s,%s,%s,%s,%s)",
                        (p["id"], key, args.alt or "", mime, len(data)))
        md = f"![{args.alt or ''}](/blog-img/{key})"
        if args.replace:
            n = p["body"].count(f"]({args.replace})")
            if not n:
                raise SystemExit(f"Uploaded, but {args.replace} isn't referenced in {p['slug']}. Use: {md}")
            cur.execute("UPDATE blog_posts SET body=%s WHERE id=%s",
                        (p["body"].replace(f"]({args.replace})", f"](/blog-img/{key})"), p["id"]))
            print(f"Uploaded and replaced {n} reference(s) to {args.replace} in {p['slug']}.")
        else:
            print(f"Uploaded. Put this in the post:\n{md}")
    conn.commit()


def cmd_export(cfg, conn, args):
    out = Path(args.repo) / "blog/posts"
    zone = tz(cfg)
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM blog_posts WHERE status IN ('scheduled','published') AND publish_at IS NOT NULL")
        posts = cur.fetchall()
        want = {f"{p['slug']}.md": (p, export_text(p, zone)) for p in posts}
        changes = []
        for name, (p, text) in sorted(want.items()):
            f = out / name
            old = f.read_text() if f.exists() else None
            if old != text:
                changes.append(("add" if old is None else "update", name))
                if not args.dry_run:
                    out.mkdir(parents=True, exist_ok=True)
                    f.write_text(text)
            if not args.dry_run:
                cur.execute("UPDATE blog_posts SET exported_hash=%s WHERE id=%s", (hashlib.sha256(text.encode()).hexdigest(), p["id"]))
        for f in sorted(out.glob("*.md")) if out.exists() else []:
            if f.name not in want:  # drafts and archived posts don't belong on the site
                changes.append(("remove", f.name))
                if not args.dry_run:
                    f.unlink()
    if not args.dry_run:
        conn.commit()
    for action, name in changes:
        print(f"{'would ' if args.dry_run else ''}{action} blog/posts/{name}")
    print(("Nothing to change." if not changes else
           "Dry run: nothing written." if args.dry_run else
           "Done. Review with git diff, commit, and push (ask the user first) to deploy."))


# Health checks

class Checks:
    def __init__(self):
        self.rows = []

    def add(self, post_id, kind, target, ok, detail=""):
        self.rows.append((post_id, kind, target, ok, detail))
        print(f"{'ok  ' if ok else 'FAIL'} {target}{'  ' + detail if detail else ''}")

    def save(self, conn, now):
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO blog_checks (post_id, checked_at, kind, target, ok, detail) VALUES (%s,%s,%s,%s,%s,%s)",
                            [(pid, now, kind, t[:500], ok, d[:1000]) for pid, kind, t, ok, d in self.rows])
        conn.commit()

    @property
    def failed(self):
        return sum(1 for r in self.rows if not r[3])


def local_build(repo, now_utc):
    out = tempfile.mkdtemp(prefix="blog-check-")
    env = {**os.environ, "BLOG_BUILD_TIME": now_utc.isoformat()}
    r = subprocess.run(["node", "-e", f"require('./scripts/build-pages').build({{ out: {json.dumps(out)} }})"],
                       cwd=repo, env=env, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"The site build failed:\n{r.stderr.strip()[-2000:]}")
    return Path(out)


def page_refs(html):
    return re.findall(r'(?:href|src)="([^"]+)"', html)


def resolves(dist, ref):
    path = ref.split("#")[0].split("?")[0]
    if not path:
        return True
    f = dist / path.lstrip("/")
    return f.is_file() or (f / "index.html").is_file() or Path(str(f) + ".html").is_file()


def check_local(conn, cfg, repo, now_local, checks):
    zone = tz(cfg)
    dist = local_build(repo, now_local.replace(tzinfo=zone).astimezone(timezone.utc))
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM blog_posts WHERE status IN ('scheduled','published') AND publish_at IS NOT NULL ORDER BY publish_at")
        posts = cur.fetchall()
        cur.execute("SELECT r2_key FROM blog_images")
        keys = {r["r2_key"] for r in cur.fetchall()}
    for p in posts:
        f = Path(repo) / "blog/posts" / f"{p['slug']}.md"
        if not f.exists() or f.read_text() != export_text(p, zone):
            checks.add(p["id"], "local", f"blog/posts/{p['slug']}.md", False, "not exported or out of date: run export")
        due = p["publish_at"] <= now_local
        built = (dist / "blog" / p["slug"] / "index.html").exists()
        if due != built:
            checks.add(p["id"], "local", f"/blog/{p['slug']}/", False,
                       "due but missing from the build" if due else "built before its date")
        elif not due:
            checks.add(p["id"], "local", f"/blog/{p['slug']}/", True, f"goes live {p['publish_at']:%b %d %H:%M}")
    for page in sorted((dist / "blog").rglob("index.html")):
        rel = "/" + str(page.parent.relative_to(dist)) + "/"
        pid = next((p["id"] for p in posts if rel == f"/blog/{p['slug']}/"), None)
        bad = []
        for ref in page_refs(page.read_text()):
            if ref.startswith("/blog-img/"):
                if ref[len("/blog-img/"):] not in keys or not KEY_RE.match(ref[len("/blog-img/"):]):
                    bad.append(f"unknown image {ref}")
            elif ref.startswith("/"):
                if not resolves(dist, ref):
                    bad.append(f"broken link {ref}")
            elif re.match(r"https?://", ref) and re.search(rf'<img[^>]+src="{re.escape(ref)}"', page.read_text()):
                bad.append(f"external image {ref} (blocked by the site's CSP; use add-image)")
        checks.add(pid, "local", rel, not bad, "; ".join(bad))
    return posts


def fetch(url, follow=True, timeout=20):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": "mariadb-auto-blogger/1 (health check)"})
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read(2_000_000)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(200_000)
    except (urllib.error.URLError, TimeoutError) as e:
        return 0, {}, str(getattr(e, "reason", e)).encode()


def check_live(conn, cfg, posts, now_local, checks):
    import html as htmllib
    site = (cfg.get("BLOG_SITE_URL") or "https://snowseasonstech.net").rstrip("/")
    due = [p for p in posts if p["publish_at"] <= now_local]
    code, _, landing = fetch(f"{site}/blog/")
    landing = landing.decode("utf-8", "replace")
    checks.add(None, "live", f"{site}/blog/", code == 200 and "<h1>Blog</h1>" in landing,
               "" if code == 200 and "<h1>Blog</h1>" in landing else
               f"HTTP {code}" + (", but it isn't the blog landing page (is the domain serving this repo?)" if code == 200 else ""))
    for p in due:
        url = f"{site}/blog/{p['slug']}/"
        code, _, body = fetch(url)
        page = body.decode("utf-8", "replace")
        ok = code == 200 and f"<h1>{htmllib.escape(p['title'])}</h1>" in page
        checks.add(p["id"], "live", url, ok, "" if ok else f"HTTP {code}" + (", but the page isn't this post" if code == 200 else ""))
        if ok and f"/blog/{p['slug']}/" not in landing:
            checks.add(p["id"], "live", f"{site}/blog/ lists {p['slug']}", False, "missing from the landing page")
        for ref in sorted(set(r for r in page_refs(page) if r.startswith("/blog-img/"))) if ok else []:
            c, h, _ = fetch(site + ref, follow=False)
            loc = h.get("Location", "")
            if c != 302 or "r2.cloudflarestorage.com" not in loc or "X-Amz-Expires=" not in loc:
                checks.add(p["id"], "live", site + ref, False, f"expected a 302 to a signed R2 URL, got HTTP {c}")
                continue
            c2, h2, _ = fetch(loc)
            ttl = re.search(r"X-Amz-Expires=(\d+)", loc).group(1)
            ok_img = c2 == 200 and h2.get("Content-Type", "").startswith("image/")
            checks.add(p["id"], "live", site + ref, ok_img, f"signed URL expires in {ttl}s" if ok_img else f"signed URL gave HTTP {c2}")
        if ok:
            with conn.cursor() as cur:
                cur.execute("UPDATE blog_posts SET status=IF(status='scheduled','published',status), live_checked_at=%s WHERE id=%s",
                            (now_local, p["id"]))


def cmd_check(cfg, conn, args):
    now_local = datetime.now(tz(cfg)).replace(tzinfo=None, microsecond=0)
    checks = Checks()
    posts = check_local(conn, cfg, args.repo, now_local, checks)
    if args.live:
        check_live(conn, cfg, posts, now_local, checks)
    checks.save(conn, now_local)
    print(f"\n{len(checks.rows) - checks.failed} passed, {checks.failed} failed")
    return 1 if checks.failed else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="site repo root (default: current directory)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("import").add_argument("files", nargs="+")
    sub.add_parser("list")
    s = sub.add_parser("schedule")
    s.add_argument("slug")
    s.add_argument("when")
    sub.add_parser("unschedule").add_argument("slug")
    sub.add_parser("archive").add_argument("slug")
    a = sub.add_parser("add-image")
    a.add_argument("slug")
    a.add_argument("file")
    a.add_argument("--alt", default="")
    a.add_argument("--replace", metavar="REF", help="swap this image path in the post for the uploaded one")
    sub.add_parser("export").add_argument("--dry-run", action="store_true")
    sub.add_parser("check").add_argument("--live", action="store_true", help="also fetch the real site (read-only)")
    args = ap.parse_args(argv)
    if not (Path(args.repo) / "scripts/build-blog.js").exists():
        sys.exit("Run this from the snowseasonstech.net repo root, or pass --repo.")
    cfg = load_config(args.repo)
    conn = connect(cfg)
    import pymysql
    try:
        return globals()[f"cmd_{args.cmd.replace('-', '_')}"](cfg, conn, args) or 0
    except pymysql.MySQLError as e:
        sys.exit(db_error(e))
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
