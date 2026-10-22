"""Tests for blogger.py. Run from the repo root:

  uv run --with pytest --with pymysql --with python-dotenv pytest .claude/skills/mariadb-auto-blogger/scripts -q

Database tests run in one transaction on the configured database and roll back, so they leave nothing behind.
Nothing here uploads to R2 or fetches the real site.
"""

import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blogger  # noqa: E402

REPO = Path(__file__).resolve().parents[4]
DEN = ZoneInfo("America/Denver")


# Pure functions

def test_parse_markdown_front_matter_and_fallbacks():
    meta, body = blogger.parse_markdown('---\ntitle: "Hello: World"\ndescription: \'Short\'\nslug: Hello World!\n---\n# Hello\n\nText')
    assert meta["title"] == "Hello: World" and meta["description"] == "Short" and meta["slug"] == "hello-world"
    assert body.startswith("# Hello")
    meta, _ = blogger.parse_markdown("# Only A Heading\n\nText", "file-name")
    assert meta["title"] == "Only A Heading" and meta["slug"] == "file-name"


def test_export_text_uses_the_local_offset_and_is_stable():
    p = {"title": 'Say "hi"', "slug": "s", "publish_at": datetime(2026, 11, 2, 6, 0), "description": "d",
         "keywords": "", "author": "A", "body": "Body\n\n"}
    text = blogger.export_text(p, DEN)
    assert 'title: "Say \\"hi\\""' in text and "date: 2026-11-02T06:00:00-07:00" in text
    assert "keywords" not in text and text.endswith("Body\n")
    assert text == blogger.export_text(dict(p), DEN)
    assert "-06:00" in blogger.export_text({**p, "publish_at": datetime(2026, 10, 26, 6, 0)}, DEN)


def test_parse_when_defaults_to_six_am():
    assert blogger.parse_when("2026-11-02") == datetime(2026, 11, 2, 6, 0)
    assert blogger.parse_when("2026-11-02T09:30") == datetime(2026, 11, 2, 9, 30)
    with pytest.raises(SystemExit):
        blogger.parse_when("next tuesday")


def test_presign_matches_the_aws_example():
    url = blogger.presign("GET", "examplebucket.s3.amazonaws.com", "/test.txt", "AKIAIOSFODNN7EXAMPLE",
                          "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region="us-east-1", expires=86400,
                          now=datetime(2013, 5, 24, tzinfo=timezone.utc))
    assert url.endswith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")


# Database

class NoCommit:
    """The real connection, but commits are ignored so the test's transaction can be rolled back."""

    def __init__(self, conn):
        self.conn = conn

    def cursor(self):
        return self.conn.cursor()

    def commit(self):
        pass


@pytest.fixture
def cfg():
    c = blogger.load_config(REPO)
    if not c.get("BLOG_DB_NAME"):
        pytest.skip("no blog database configured")
    return c


@pytest.fixture
def conn(cfg):
    c = blogger.connect(cfg)
    c.begin()
    yield NoCommit(c)
    c.rollback()
    c.close()


@pytest.fixture
def site(tmp_path):
    """A copy of the site with no posts, so exports and builds don't touch the real repo."""
    root = tmp_path / "site"
    shutil.copytree(REPO, root, ignore=shutil.ignore_patterns(".git", "dist", "node_modules", ".claude", "posts"))
    (root / "node_modules").symlink_to(REPO / "node_modules")
    (root / "blog" / "posts").mkdir(parents=True, exist_ok=True)
    return root


def args(site, **kw):
    return SimpleNamespace(**{"repo": str(site), "dry_run": False, "live": False, **kw})


def write_md(tmp_path, name, text):
    f = tmp_path / name
    f.write_text(text)
    return str(f)


def post(conn, slug):
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM blog_posts WHERE slug=%s", (slug,))
        return cur.fetchone()


def test_import_schedule_export_and_unpublish(cfg, conn, site, tmp_path, capsys):
    a = write_md(tmp_path, "a.md", '---\ntitle: "ZZ Test A"\nslug: zz-test-a\ndescription: "First"\n---\n# ZZ Test A\n\n![hero](/assets/hero.png)\n')
    b = write_md(tmp_path, "zz-test-b.md", "# ZZ Test B\n\nSecond.\n")
    blogger.cmd_import(cfg, conn, args(site, files=[a, b, a]))
    out = capsys.readouterr().out
    assert "added draft zz-test-a" in out and "added draft zz-test-b" in out and "already in the database" in out
    assert "add-image zz-test-a <file> --replace /assets/hero.png" in out
    assert post(conn, "zz-test-a")["status"] == "draft"

    blogger.cmd_schedule(cfg, conn, args(site, slug="zz-test-a", when="2026-11-02"))
    assert post(conn, "zz-test-a")["publish_at"] == datetime(2026, 11, 2, 6, 0)
    blogger.cmd_export(cfg, conn, args(site, dry_run=True))
    assert not (site / "blog/posts/zz-test-a.md").exists()
    blogger.cmd_export(cfg, conn, args(site))
    text = (site / "blog/posts/zz-test-a.md").read_text()
    assert "slug: zz-test-a" in text and "date: 2026-11-02T06:00:00-07:00" in text
    assert not (site / "blog/posts/zz-test-b.md").exists()  # drafts stay off the site
    assert post(conn, "zz-test-a")["exported_hash"]

    capsys.readouterr()
    blogger.cmd_export(cfg, conn, args(site))
    assert "Nothing to change" in capsys.readouterr().out

    blogger.cmd_archive(cfg, conn, args(site, slug="zz-test-a"))
    blogger.cmd_export(cfg, conn, args(site))
    assert not (site / "blog/posts/zz-test-a.md").exists()


def test_add_image_uploads_with_a_presigned_put_and_rewrites_the_post(cfg, conn, site, tmp_path, capsys):
    blogger.cmd_import(cfg, conn, args(site, files=[write_md(tmp_path, "zz-test-c.md", "# ZZ Test C\n\n![hero](/assets/hero.png)\n")]))
    img = tmp_path / "hero.png"
    img.write_bytes(b"\x89PNG fake image bytes")
    sent = []

    class Resp:
        def close(self):
            pass

    def opener(req, timeout):
        sent.append(req)
        return Resp()

    r2 = {**cfg, "R2_ACCOUNT_ID": "acct", "R2_ACCESS_KEY_ID": "AK", "R2_SECRET_ACCESS_KEY": "SK", "R2_BUCKET": "media"}
    a = args(site, slug="zz-test-c", file=str(img), alt="Hero", replace="/assets/hero.png")
    blogger.cmd_add_image(r2, conn, a, opener=opener)
    assert len(sent) == 1 and sent[0].get_method() == "PUT" and sent[0].data == img.read_bytes()
    assert sent[0].full_url.startswith("https://acct.r2.cloudflarestorage.com/media/blog/zz-test-c/")
    assert "X-Amz-Signature=" in sent[0].full_url and "SK" not in sent[0].full_url
    body = post(conn, "zz-test-c")["body"]
    key = body.split("](/blog-img/")[1].split(")")[0]
    assert blogger.KEY_RE.match(key) and "/assets/hero.png" not in body
    blogger.cmd_add_image(r2, conn, args(site, slug="zz-test-c", file=str(img), alt="Hero", replace=None), opener=opener)
    assert len(sent) == 1  # same bytes, same key: not uploaded twice
    with pytest.raises(SystemExit, match="R2_"):
        blogger.r2_put({}, "k", b"", "image/png")


def test_local_check_finds_unexported_posts_broken_links_and_external_images(cfg, conn, site, tmp_path, capsys):
    blogger.cmd_import(cfg, conn, args(site, files=[
        write_md(tmp_path, "zz-test-d.md", "# ZZ Test D\n\n[gone](/no-such-page) and [home](/#contact)\n\n![x](https://example.com/x.png)\n"),
        write_md(tmp_path, "zz-test-e.md", "# ZZ Test E\n\nFine.\n"),
        write_md(tmp_path, "zz-test-f.md", "# ZZ Test F\n\nLater.\n"),
    ]))
    now = datetime.now(DEN).replace(tzinfo=None, microsecond=0)
    blogger.cmd_schedule(cfg, conn, args(site, slug="zz-test-d", when=(now - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M")))
    blogger.cmd_schedule(cfg, conn, args(site, slug="zz-test-e", when=(now - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M")))
    blogger.cmd_schedule(cfg, conn, args(site, slug="zz-test-f", when=(now + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M")))
    blogger.cmd_export(cfg, conn, args(site))
    blogger.cmd_schedule(cfg, conn, args(site, slug="zz-test-e", when=(now - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M")))
    checks = blogger.Checks()
    capsys.readouterr()
    blogger.check_local(conn, cfg, str(site), now, checks)
    by = {(r[2], r[3]): r[4] for r in checks.rows}
    assert "broken link /no-such-page" in by[("/blog/zz-test-d/", False)]
    assert "external image https://example.com/x.png" in by[("/blog/zz-test-d/", False)]
    assert "not exported or out of date" in by[("blog/posts/zz-test-e.md", False)]
    assert by[("/blog/zz-test-e/", True)] == ""
    assert "goes live" in by[("/blog/zz-test-f/", True)]
    assert ("/blog/", True) in by


def test_live_check_spots_a_site_that_isnt_serving_the_blog(cfg, conn, site, tmp_path, monkeypatch):
    blogger.cmd_import(cfg, conn, args(site, files=[write_md(tmp_path, "zz-test-g.md", "# ZZ Test G\n\nLive.\n")]))
    blogger.cmd_schedule(cfg, conn, args(site, slug="zz-test-g", when="2026-01-01"))
    p = post(conn, "zz-test-g")
    spa = b"<html><title>ScaleKit</title></html>"
    monkeypatch.setattr(blogger, "fetch", lambda url, follow=True, timeout=20: (200, {}, spa))
    checks = blogger.Checks()
    blogger.check_live(conn, cfg, [p], datetime(2026, 6, 1), checks)
    assert checks.failed == 2 and "isn't the blog landing page" in checks.rows[0][4] and "isn't this post" in checks.rows[1][4]
    assert post(conn, "zz-test-g")["status"] == "scheduled"

    pages = {
        "https://snowseasonstech.net/blog/": b"<h1>Blog</h1><a href=\"/blog/zz-test-g/\">",
        "https://snowseasonstech.net/blog/zz-test-g/": b'<h1>ZZ Test G</h1><img src="/blog-img/blog/zz-test-g/0123456789abcdef.png">',
        "https://snowseasonstech.net/blog-img/blog/zz-test-g/0123456789abcdef.png": None,
        "https://acct.r2.cloudflarestorage.com/x?X-Amz-Expires=3600&X-Amz-Signature=s": b"PNG",
    }

    def fake(url, follow=True, timeout=20):
        if "/blog-img/" in url:
            return 302, {"Location": "https://acct.r2.cloudflarestorage.com/x?X-Amz-Expires=3600&X-Amz-Signature=s"}, b""
        if "r2.cloudflarestorage" in url:
            return 200, {"Content-Type": "image/png"}, pages[url]
        return 200, {}, pages[url]

    monkeypatch.setattr(blogger, "fetch", fake)
    checks = blogger.Checks()
    blogger.check_live(conn, cfg, [p], datetime(2026, 6, 1), checks)
    assert checks.failed == 0 and any("expires in 3600s" in r[4] for r in checks.rows)
    assert post(conn, "zz-test-g")["status"] == "published"
