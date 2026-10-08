#!/usr/bin/env python3
"""Generate local configuration without putting credentials in shell history."""
import getpass
import os
import secrets
from pathlib import Path
from urllib.parse import urlparse
root = Path(__file__).resolve().parents[1]
try:
    path = root / '.env'
    if path.exists(): raise ValueError('.env already exists; edit it directly')
    origin = input('Portal origin [http://localhost:8080]: ').strip() or 'http://localhost:8080'
    parsed = urlparse(origin)
    if parsed.scheme not in {'http','https'} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment: raise ValueError('Use an origin without a path or trailing slash')
    endpoint = input('S3 endpoint (blank for AWS): ').strip()
    public = input('Browser-reachable S3 endpoint (blank = same): ').strip()
    region = input('S3 region [us-east-1]: ').strip() or 'us-east-1'
    bucket = input('Existing private S3 bucket: ').strip()
    key = input('Application S3 access key: ').strip()
    secret = getpass.getpass('Application S3 secret key: ')
    if not bucket or not key or not secret: raise ValueError('Storage credentials and bucket are required')
    password = secrets.token_urlsafe(36)
    values = dict(POSTGRES_PASSWORD=password, DATABASE_URL=f'postgresql+psycopg://appforge:{password}@postgres:5432/appforge', PUBLIC_ORIGIN=origin, COOKIE_SECURE=str(parsed.scheme == 'https').lower(), S3_ENDPOINT=endpoint or 'null', S3_PUBLIC_ENDPOINT=public or 'null', S3_REGION=region, S3_BUCKET=bucket, S3_ACCESS_KEY=key, S3_SECRET_KEY=secret)
    # Omit optional empty endpoint fields; Pydantic uses None defaults.
    values = {k:v for k,v in values.items() if v != 'null'}
    if any(any(c in v for c in "\n\r'\\") for v in values.values()): raise ValueError('Unsupported characters in configuration')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        for k,v in values.items(): f.write(f"{k}='{v}'\n")
    (root / 'packages').mkdir(exist_ok=True)
    print('Configuration created. Run docker compose up --build -d.')
except (OSError, ValueError) as exc:
    raise SystemExit(str(exc))
