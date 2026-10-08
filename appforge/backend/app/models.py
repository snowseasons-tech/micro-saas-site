from datetime import datetime
from sqlalchemy import String, ForeignKey, UniqueConstraint, DateTime, Boolean, BigInteger, Text
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
class User(Base):
    __tablename__ = 'users'
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
class Session(Base):
    __tablename__ = 'sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
class Application(Base):
    __tablename__ = 'applications'
    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default='')
    category: Mapped[str] = mapped_column(String(80), default='operations')
class Release(Base):
    __tablename__ = 'releases'
    __table_args__ = (UniqueConstraint('application_id', 'version', 'platform', 'channel'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey('applications.id'))
    version: Mapped[str] = mapped_column(String(80))
    platform: Mapped[str] = mapped_column(String(40))
    channel: Mapped[str] = mapped_column(String(20), default='stable')
    filename: Mapped[str] = mapped_column(String(200))
    object_key: Mapped[str] = mapped_column(String(500), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(BigInteger)
    notes: Mapped[str] = mapped_column(Text, default='')
class Entitlement(Base):
    __tablename__ = 'entitlements'
    __table_args__ = (UniqueConstraint('user_id', 'application_id'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    application_id: Mapped[int] = mapped_column(ForeignKey('applications.id'))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
class Audit(Base):
    __tablename__ = 'download_audit'
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    release_id: Mapped[int] = mapped_column(ForeignKey('releases.id'))
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
