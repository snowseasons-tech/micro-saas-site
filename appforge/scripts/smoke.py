#!/usr/bin/env python3
"""Check a running deployment, including actual S3 bytes and SHA-256."""
import argparse
import getpass
import hashlib
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('origin', help='Exact PUBLIC_ORIGIN, without a trailing slash')
p.add_argument('email')
p.add_argument('release_id', type=int, help='Release the customer is entitled to download')
args = p.parse_args()
try:
    parsed = urlparse(args.origin)
    if parsed.scheme not in {'http','https'} or parsed.path or not parsed.netloc:
        raise ValueError('Invalid origin')
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    def api(path, body=None):
        request = urllib.request.Request(args.origin+'/api'+path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Origin':args.origin,'Content-Type':'application/json'})
        with opener.open(request, timeout=30) as response:
            data = response.read()
            return json.loads(data) if data else None
    assert api('/health')['status'] == 'healthy', 'Health failed'
    try:
        api(f'/releases/{args.release_id}/download', {})
        raise ValueError('Anonymous download was allowed')
    except urllib.error.HTTPError as exc:
        if exc.code != 401: raise ValueError('Unexpected anonymous response') from None
    api('/auth/login', {'email':args.email,'password':getpass.getpass('Customer password: ')})
    result = api(f'/releases/{args.release_id}/download', {})
    digest = hashlib.sha256()
    # Separate opener prevents sending portal cookies to the storage host.
    with urllib.request.urlopen(result['url'], timeout=60) as response:
        for chunk in iter(lambda: response.read(1024*1024), b''): digest.update(chunk)
    if digest.hexdigest() != result['sha256']: raise ValueError('Downloaded checksum mismatch')
    api('/auth/logout', {})
    try:
        api('/me')
        raise ValueError('Session survived logout')
    except urllib.error.HTTPError as exc:
        if exc.code != 401: raise ValueError('Unexpected logout response') from None
    print('PASS: health, anonymous rejection, login, authorized S3 download, checksum, logout.')
except (ValueError, AssertionError, OSError, urllib.error.URLError, json.JSONDecodeError, KeyError) as exc:
    # Signed URLs must never appear in diagnostics.
    print(f'Smoke test failed ({type(exc).__name__}); inspect service logs and configuration.', file=sys.stderr)
    raise SystemExit(1)
