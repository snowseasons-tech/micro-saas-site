"""Administrator operations; run inside the API container."""
import argparse
import getpass
import hashlib
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import select, delete
from sqlalchemy.exc import SQLAlchemyError
from botocore.exceptions import BotoCoreError, ClientError
from pydantic import TypeAdapter, EmailStr
from .db import SessionLocal
from .models import User, Application, Release, Entitlement, Session
from .main import passwords
from . import storage
from .config import settings

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('user'); p.add_argument('email')
    p = sub.add_parser('application'); p.add_argument('slug'); p.add_argument('name'); p.add_argument('--description', default=''); p.add_argument('--category', default='operations')
    p = sub.add_parser('grant'); p.add_argument('email'); p.add_argument('slug'); p.add_argument('--expires', help='ISO-8601 UTC, e.g. 2027-01-01T00:00:00+00:00')
    p = sub.add_parser('revoke'); p.add_argument('email'); p.add_argument('slug')
    p = sub.add_parser('disable-user'); p.add_argument('email')
    p = sub.add_parser('publish'); p.add_argument('slug'); p.add_argument('version'); p.add_argument('platform', choices=['windows-x64','linux-x64','linux-arm64','macos-arm64','macos-x64','docker']); p.add_argument('file'); p.add_argument('--channel', choices=['stable','beta','dev'], default='stable'); p.add_argument('--notes', default='')
    args = parser.parse_args()
    try:
        with SessionLocal() as db:
            if hasattr(args, 'email'):
                email = str(TypeAdapter(EmailStr).validate_python(args.email)).lower()
                user = db.scalar(select(User).where(User.email == email))
            if args.command == 'user':
                if user: raise ValueError('User already exists')
                password = getpass.getpass('New password: ')
                if len(password) < 12 or len(password) > 256: raise ValueError('Password must be 12–256 characters')
                if password != getpass.getpass('Confirm password: '): raise ValueError('Passwords do not match')
                db.add(User(email=email, password_hash=passwords.hash(password)))
            elif args.command == 'disable-user':
                if not user: raise ValueError('User not found')
                user.active = False
                db.execute(delete(Session).where(Session.user_id == user.id))
            elif args.command == 'application':
                if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', args.slug): raise ValueError('Invalid slug')
                db.add(Application(slug=args.slug, name=args.name, description=args.description, category=args.category))
            else:
                application = db.scalar(select(Application).where(Application.slug == args.slug))
                if not application: raise ValueError('Application not found')
                if args.command in {'grant','revoke'}:
                    if not user: raise ValueError('User not found')
                    grant = db.scalar(select(Entitlement).where(Entitlement.user_id == user.id, Entitlement.application_id == application.id))
                    if not grant:
                        grant = Entitlement(user_id=user.id, application_id=application.id); db.add(grant)
                    grant.active = args.command == 'grant'
                    if args.command == 'grant':
                        grant.expires_at = datetime.fromisoformat(args.expires) if args.expires else None
                        if grant.expires_at and (grant.expires_at.tzinfo is None or grant.expires_at <= datetime.now(timezone.utc)):
                            raise ValueError('Expiry must include timezone and be in the future')
                elif args.command == 'publish':
                    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', args.version): raise ValueError('Invalid version')
                    file = Path(args.file)
                    if not re.fullmatch(r'[A-Za-z0-9._-]{1,200}', file.name): raise ValueError('Use a simple ASCII package filename')
                    existing = db.scalar(select(Release).where(Release.application_id == application.id, Release.version == args.version, Release.platform == args.platform, Release.channel == args.channel))
                    if existing: raise ValueError('Release already exists; publish a new version')
                    key = f'packages/{application.slug}/{uuid.uuid4().hex}/{file.name}'
                    s3 = storage.client()
                    with file.open('rb') as stream:
                        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                        size = file.stat().st_size
                        stream.seek(0)
                        s3.upload_fileobj(stream, settings.s3_bucket, key, ExtraArgs={'Metadata': {'sha256': digest}})
                    db.add(Release(application_id=application.id, version=args.version, platform=args.platform, channel=args.channel, filename=file.name, object_key=key, sha256=digest, size=size, notes=args.notes))
                    try:
                        db.commit()
                    except SQLAlchemyError:
                        s3.delete_object(Bucket=settings.s3_bucket, Key=key)
                        raise
                    print(f'Published {file.name}; SHA-256 {digest}')
                    return
            db.commit()
            print('Done')
    except (ValueError, OSError, SQLAlchemyError, BotoCoreError, ClientError) as exc:
        # Do not print connection strings, SQL parameters, or credentials.
        parser.exit(1, f'Operation failed ({type(exc).__name__}). Check input, database, and storage.\n')
if __name__ == '__main__': main()
