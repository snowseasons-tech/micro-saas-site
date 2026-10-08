# AppForge — business application delivery

A working first backend release for SnowSeasonsTech. Docker runs FastAPI, PostgreSQL 18, Alembic migrations, and an Nginx customer portal. Private packages live in an existing S3-compatible bucket, outside the website. The UI preserves the original AppForge dark blue/purple visual style.

## Included

- Administrator-created customers; Argon2 password hashing.
- Revocable database sessions with HttpOnly, SameSite cookies. No browser token storage.
- Application catalog, search/category filters, platform builds, stable/beta/dev release channels and release notes.
- Per-customer application entitlements, optional expiry, immediate revocation of future download requests.
- Immutable release records, streamed package publishing, SHA-256 checksums.
- Two-minute presigned downloads and an audit record for each URL issued.
- Alembic schema migration, pinned Python dependencies with hashes, dependency health endpoint.
- CLI administration. No public registration, admin web panel, billing, organization membership, cryptographic release signing, email delivery, or password recovery UI yet.

## Storage decision

MinIO's community repository was archived on April 25, 2026 and explicitly says it is no longer maintained: https://github.com/minio/minio . This project supports its S3 protocol but does not silently deploy an obsolete server image. Use AWS S3 or an actively supported S3-compatible service; for local MinIO, use a supported AIStor deployment and follow its current licensing/setup documentation.

For an existing MinIO service, set S3_ENDPOINT to the API address reachable from the API container (not its console port), S3_PUBLIC_ENDPOINT to the browser-reachable API address, and use a dedicated application access key. Docker `localhost` refers to the container itself. Linux hosts can add an extra_hosts mapping for host.docker.internal if needed. The configured public endpoint must reach the SAME bucket/server; signatures bind the host, so never rewrite a signed URL after generating it. API backend traffic uses the internal endpoint, while URLs are signed using the public endpoint.

## Start on your server

Requires Docker Engine with the Compose plugin and Python 3.12+ for the configuration script. This assumes you already have a PRIVATE bucket and application-scoped S3 credentials.

```bash
unzip appforge-docker-platform.zip
cd appforge
python3 scripts/configure.py
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs migrate api
curl --fail http://localhost:8080/api/health
```

The configuration script prompts for storage settings and generates a database password. It writes a mode-0600 .env file and refuses to overwrite existing configuration. Credentials are not printed. Keep .env out of Git and backups shared with clients. The PostgreSQL volume is persistent and is mounted at /var/lib/postgresql for PostgreSQL 18.

Open http://localhost:8080 . The default binding is loopback. To access it securely from another machine without opening a public port:

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-server
```

Use http://localhost:8080 in the browser. PUBLIC_ORIGIN must match the actual browser origin exactly, including port; it is used to reject cross-origin state-changing requests. The local HTTP mode intentionally disables Secure cookies. Public deployments must use HTTPS and COOKIE_SECURE=true.

## First customer and application

```bash
docker compose exec api python -m app.cli user customer@example.com
# Password is prompted twice; minimum 12 characters.
docker compose exec api python -m app.cli application inventory-suite 'Inventory Suite' \
  --description 'Inventory and purchasing tools' --category operations
mkdir -p packages
# Copy YOUR built installer/archive into packages/, e.g. inventory-1.0.0-linux-x64.zip.
docker compose exec api python -m app.cli publish inventory-suite 1.0.0 linux-x64 \
  /packages/inventory-1.0.0-linux-x64.zip --notes 'Initial customer release'
docker compose exec api python -m app.cli grant customer@example.com inventory-suite
```

Sign in to the portal with the customer account. Expand the release and download it. For the first published release (ID 1), run a real service smoke test:

```bash
python3 scripts/smoke.py http://localhost:8080 customer@example.com 1
```

This prompts for the customer password, verifies anonymous rejection, downloads the real S3 object without retaining it, checks SHA-256, and verifies logout. The package itself is not included in this repository: publish your real business application builds.

Publishing permits simple ASCII filenames and uses a unique object key per release. A duplicate version/platform/channel is rejected. Failed database commits attempt to delete the uploaded object. A process interruption can leave an orphan object: audit storage before removing orphan keys. Builds should finish before the publisher reads them; do not modify package files while publishing.

Grant expiring access, revoke a license, or disable a customer:

```bash
docker compose exec api python -m app.cli grant customer@example.com inventory-suite \
  --expires 2027-01-01T00:00:00+00:00
docker compose exec api python -m app.cli revoke customer@example.com inventory-suite
docker compose exec api python -m app.cli disable-user customer@example.com
```

Disabling a user removes their sessions and blocks login. Entitlements cover every release/channel for an application; channel-specific entitlements are not implemented. Revocation prevents NEW links; already-issued URLs remain usable until expiry. Presigned URLs are bearer credentials, not single-use links. Do not paste them into tickets or logs. Audit records show links issued, not proof of a completed download.

## S3 policy and protection

Create the bucket privately before starting. With AWS, enable all Block Public Access settings, bucket encryption and preferably versioning. Do not grant anonymous access or disable block-public-access to fix a 403. No bucket CORS policy is needed for a normal browser download/navigation.

Copy storage-policy.json, replace YOUR_BUCKET_NAME in both ARN entries, and attach it to a dedicated application identity. It grants only the list/check, read, write and rollback-delete operations used here. It does not create buckets or change bucket policy. Both publishing and delivery currently use this identity; split the publisher credentials from the read-only runtime identity in a later operational hardening pass. Use HTTPS for all public S3 endpoints. For third-party S3, verify equivalent permissions and policies in that provider.

Verify unauthorized access to the object URL returns AccessDenied. Check that a valid issued URL downloads the exact file, and that it fails after expiry. Compare the checksum on the client:

```bash
sha256sum inventory-1.0.0-linux-x64.zip
```

Windows: Get-FileHash package.zip -Algorithm SHA256. macOS: shasum -a 256 package.zip. A checksum detects changed bytes; it does not provide publisher identity like a cryptographic signature.

## HTTPS deployment

Keep port 8080 on loopback and terminate TLS at your existing reverse proxy. Route a dedicated hostname, e.g. apps.example.com, to 127.0.0.1:8080. Preserve the browser Origin header. Set PUBLIC_ORIGIN=https://apps.example.com and COOKIE_SECURE=true in .env, then recreate the API:

```bash
docker compose up -d --force-recreate api
```

Do not expose the API container directly: Nginx applies login rate limiting and security headers. If an outer proxy fronts Nginx, rate limiting initially shares the proxy IP; configure Nginx real_ip_header and set_real_ip_from only for explicitly trusted proxy addresses, or implement per-client limits on your outer proxy. Never trust arbitrary X-Forwarded-For headers. Enable HSTS at the TLS proxy only after HTTPS is confirmed.

Run at least a Docker smoke test with your actual PostgreSQL and storage before onboarding clients. Exercise a successful login/download and an expired or revoked entitlement. Back up and restore PostgreSQL and bucket data together. Inspect pinned Python and container dependencies for updates; image tags are version families, not immutable digest locks. Pin deployed image digests in your release pipeline after testing them. Limit SSH/Docker administration to trusted administrators: Docker exec is the administrative interface in this release.

## Operations

```bash
# Database backup (contains sensitive customer data)
docker compose exec -T postgres pg_dump -U appforge -d appforge -Fc > appforge-backup.dump
# Audit entries, newest first
docker compose exec postgres psql -U appforge -d appforge \
  -c 'SELECT * FROM download_audit ORDER BY issued_at DESC LIMIT 50;'
# Remove expired sessions periodically
docker compose exec postgres psql -U appforge -d appforge \
  -c 'DELETE FROM sessions WHERE expires_at < now();'
```

Secure and test backups. `docker compose down` preserves data; `down -v` destroys database volumes. Migration runs as a separate one-shot service. For future schema changes, add a new Alembic revision and run migrations before starting the updated API. Do not edit the initial revision after deploying it.

## Local tests

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

Tests use SQLite and a stubbed object-store boundary. They verify authentication, session cookie flags, hashed session storage, authorization before signing, revoked/expired grants, expired/disabled sessions, CSRF origin rejection, logout, object-store failure, audit records, and signing endpoint selection. They do not replace PostgreSQL/S3 integration tests. Docker and a browser were unavailable in the build environment, so container startup and visual browser behavior have not been verified here.

## API

- POST /api/auth/login — JSON email/password; Origin header required.
- POST /api/auth/logout — removes server-side session.
- GET /api/me — current customer.
- GET /api/applications — catalog and entitlement status; no object keys.
- POST /api/releases/{id}/download — authorized expiring URL and checksum.
- GET /api/health — database and bucket readiness; returns 503 on dependency failure.
- GET /docs — FastAPI docs inside the API container; not exposed by the default Nginx routes.

Sources: https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/ (Argon2/password hashing); https://docs.sqlalchemy.org/en/20/orm/ ; https://docs.aws.amazon.com/boto3/latest/guide/s3-presigned-urls.html ; https://www.psycopg.org/psycopg3/docs/basic/install.html .
