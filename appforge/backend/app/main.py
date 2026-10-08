import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field
from pwdlib import PasswordHash
from sqlalchemy import select, text
from sqlalchemy.orm import Session as DBSession
from botocore.exceptions import BotoCoreError, ClientError
from .config import settings
from .db import get_db
from .models import User, Session, Application, Release, Entitlement, Audit
from . import storage
app = FastAPI(title='AppForge API', version='1.0.0')
passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash(secrets.token_urlsafe(32))
def now():
    return datetime.now(timezone.utc)
def aware(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value

def current_user(request: Request, db: DBSession = Depends(get_db)):
    token = request.cookies.get('appforge_session', '')
    session = db.get(Session, hashlib.sha256(token.encode()).hexdigest()) if token else None
    user = db.get(User, session.user_id) if session else None
    if not session or aware(session.expires_at) <= now() or not user or not user.active:
        raise HTTPException(401, 'Sign in required')
    return user
@app.middleware('http')
async def security(request, call_next):
    if request.method not in {'GET', 'HEAD', 'OPTIONS'} and request.headers.get('origin') != settings.public_origin:
        return JSONResponse({'detail': 'Invalid origin'}, status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response
class Login(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
@app.post('/api/auth/login')
def login(body: Login, response: Response, db: DBSession = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == str(body.email).lower()))
    valid = passwords.verify(body.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid or not user.active:
        raise HTTPException(401, 'Invalid email or password')
    token = secrets.token_urlsafe(48)
    db.add(Session(token_hash=hashlib.sha256(token.encode()).hexdigest(), user_id=user.id,
        expires_at=now() + timedelta(hours=settings.session_hours)))
    db.commit()
    response.set_cookie('appforge_session', token, httponly=True, secure=settings.cookie_secure,
        samesite='strict', max_age=settings.session_hours*3600, path='/api')
    return {'email': user.email}
@app.post('/api/auth/logout', status_code=204)
def logout(request: Request, response: Response, db: DBSession = Depends(get_db)):
    token = request.cookies.get('appforge_session', '')
    row = db.get(Session, hashlib.sha256(token.encode()).hexdigest())
    if row:
        db.delete(row)
        db.commit()
    response.delete_cookie('appforge_session', path='/api', secure=settings.cookie_secure, httponly=True, samesite='strict')
@app.get('/api/me')
def me(user: User = Depends(current_user)):
    return {'email': user.email}
def entitled(db, user, app_id):
    grant = db.scalar(select(Entitlement).where(Entitlement.user_id == user.id, Entitlement.application_id == app_id))
    return bool(grant and grant.active and (grant.expires_at is None or aware(grant.expires_at) > now()))
@app.get('/api/applications')
def catalog(user: User = Depends(current_user), db: DBSession = Depends(get_db)):
    return [{'id': a.id, 'name': a.name, 'slug': a.slug, 'description': a.description, 'category': a.category,
        'entitled': entitled(db, user, a.id), 'releases': [{'id': r.id, 'version': r.version, 'platform': r.platform,
        'channel': r.channel, 'filename': r.filename, 'size': r.size, 'sha256': r.sha256, 'notes': r.notes}
        for r in db.scalars(select(Release).where(Release.application_id == a.id).order_by(Release.id.desc()))]}
        for a in db.scalars(select(Application).order_by(Application.name))]
@app.post('/api/releases/{release_id}/download')
def download(release_id: int, user: User = Depends(current_user), db: DBSession = Depends(get_db)):
    release = db.get(Release, release_id)
    if not release:
        raise HTTPException(404, 'Release not found')
    if not entitled(db, user, release.application_id):
        raise HTTPException(403, 'An active entitlement is required')
    try:
        url = storage.download_url(release)
    except (BotoCoreError, ClientError):
        raise HTTPException(503, 'Package storage is unavailable') from None
    db.add(Audit(user_id=user.id, release_id=release.id, issued_at=now()))
    db.commit()
    return {'url': url, 'expires_in': settings.download_seconds, 'sha256': release.sha256}
@app.get('/api/health')
def health(db: DBSession = Depends(get_db)):
    try:
        db.execute(text('SELECT 1'))
        storage.client().head_bucket(Bucket=settings.s3_bucket)
    except Exception:
        raise HTTPException(503, 'Dependency unavailable') from None
    return {'status': 'healthy'}
