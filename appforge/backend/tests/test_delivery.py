import os
os.environ.update(DATABASE_URL='sqlite://', PUBLIC_ORIGIN='http://testserver', COOKIE_SECURE='false', S3_BUCKET='private', S3_ACCESS_KEY='test', S3_SECRET_KEY='test')
import hashlib
from datetime import timedelta
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from botocore.exceptions import ClientError
from app.db import Base, get_db
from app.main import app, passwords, now
from app.models import User, Application, Release, Entitlement, Audit, Session
from app import storage

@pytest.fixture
def portal(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread':False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as db:
        user = User(email='customer@example.com',password_hash=passwords.hash('correct-password'))
        application = Application(slug='ledger',name='Ledger')
        db.add_all([user, application]); db.flush()
        db.add(Release(application_id=application.id,version='1.0',platform='linux-x64',filename='ledger.zip',object_key='private/ledger.zip',sha256='a'*64,size=100))
        db.commit()
    def dependency():
        with factory() as db: yield db
    app.dependency_overrides[get_db] = dependency
    calls = []
    monkeypatch.setattr(storage, 'download_url', lambda release: calls.append(release.object_key) or 'https://storage.example.com/signed')
    with TestClient(app) as client:
        client.headers['Origin'] = 'http://testserver'
        yield client, factory, calls
    app.dependency_overrides.clear()
    engine.dispose()
def login(client):
    return client.post('/api/auth/login',json={'email':'CUSTOMER@example.com','password':'correct-password'})
def grant(factory, **kwargs):
    with factory() as db:
        db.add(Entitlement(user_id=1,application_id=1, **kwargs)); db.commit()
def test_private_download_and_audit(portal):
    c, f, calls = portal
    assert c.post('/api/releases/1/download').status_code == 401
    response = login(c); assert response.status_code == 200
    assert 'HttpOnly' in response.headers['set-cookie']
    assert 'SameSite=strict' in response.headers['set-cookie']
    assert c.get('/api/applications').json()[0]['entitled'] is False
    assert c.post('/api/releases/1/download').status_code == 403
    assert calls == []
    grant(f)
    response = c.post('/api/releases/1/download')
    assert response.status_code == 200 and response.json()['expires_in'] == 120
    assert calls == ['private/ledger.zip']
    with f() as db:
        assert db.scalar(select(Audit)).user_id == 1
        session = db.scalar(select(Session))
        token = c.cookies.get('appforge_session')
        assert session.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert c.post('/api/auth/logout').status_code == 204
    assert c.get('/api/me').status_code == 401
@pytest.mark.parametrize('kwargs', [{'active':False},{'expires_at':now()-timedelta(seconds=1)}])
def test_expired_revoked(portal, kwargs):
    c,f,calls = portal; login(c); grant(f, **kwargs)
    assert c.post('/api/releases/1/download').status_code == 403
    assert calls == []
def test_session_expired_disabled_and_invalid_password(portal):
    c,f,_ = portal
    assert c.post('/api/auth/login',json={'email':'customer@example.com','password':'wrong'}).status_code == 401
    login(c)
    with f() as db:
        session = db.scalar(select(Session)); session.expires_at = now()-timedelta(seconds=1); db.commit()
    assert c.get('/api/me').status_code == 401
    login(c)
    with f() as db: db.get(User,1).active=False; db.commit()
    assert c.get('/api/me').status_code == 401
    assert login(c).status_code == 401
def test_csrf_and_storage_failure(portal, monkeypatch):
    c,f,calls = portal; login(c); grant(f)
    assert c.post('/api/releases/1/download',headers={'Origin':'https://attacker.example'}).status_code == 403
    assert calls == []
    def fail(release): raise ClientError({'Error':{'Code':'NoSuchKey'}},'HeadObject')
    monkeypatch.setattr(storage,'download_url',fail)
    assert c.post('/api/releases/1/download').status_code == 503
    with f() as db: assert db.scalar(select(Audit)) is None
    assert c.post('/api/releases/999/download').status_code == 404
def test_presign_uses_browser_endpoint(monkeypatch):
    from types import SimpleNamespace
    calls=[]
    class Fake:
        def head_object(self, **kw): calls.append(('head',kw))
        def generate_presigned_url(self, operation, **kw): calls.append((operation,kw)); return 'signed'
    monkeypatch.setattr(storage,'client',lambda public=False: calls.append(('client', public)) or Fake())
    assert storage.download_url(SimpleNamespace(object_key='private/key',filename='app.zip')) == 'signed'
    assert calls[0] == ('client',False)
    assert calls[2] == ('client',True)
    assert calls[3][1]['ExpiresIn'] == 120
