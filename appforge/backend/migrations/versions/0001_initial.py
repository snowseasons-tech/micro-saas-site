"""Initial AppForge delivery schema."""
from alembic import op
import sqlalchemy as sa
revision = '0001'
down_revision = None
branch_labels = None
depends_on = None

def upgrade():
    op.create_table('users', sa.Column('id', sa.Integer, primary_key=True), sa.Column('email', sa.String(254), nullable=False, unique=True), sa.Column('password_hash', sa.Text, nullable=False), sa.Column('active', sa.Boolean, nullable=False))
    op.create_table('sessions', sa.Column('token_hash', sa.String(64), primary_key=True), sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False), sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False))
    op.create_table('applications', sa.Column('id', sa.Integer, primary_key=True), sa.Column('slug', sa.String(80), unique=True, nullable=False), sa.Column('name', sa.String(160), nullable=False), sa.Column('description', sa.Text, nullable=False), sa.Column('category', sa.String(80), nullable=False))
    op.create_table('releases', sa.Column('id', sa.Integer, primary_key=True), sa.Column('application_id', sa.Integer, sa.ForeignKey('applications.id'), nullable=False), sa.Column('version', sa.String(80), nullable=False), sa.Column('platform', sa.String(40), nullable=False), sa.Column('channel', sa.String(20), nullable=False), sa.Column('filename', sa.String(200), nullable=False), sa.Column('object_key', sa.String(500), unique=True, nullable=False), sa.Column('sha256', sa.String(64), nullable=False), sa.Column('size', sa.BigInteger, nullable=False), sa.Column('notes', sa.Text, nullable=False), sa.UniqueConstraint('application_id','version','platform','channel'))
    op.create_table('entitlements', sa.Column('id', sa.Integer, primary_key=True), sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id'), nullable=False), sa.Column('application_id', sa.Integer, sa.ForeignKey('applications.id'), nullable=False), sa.Column('expires_at', sa.DateTime(timezone=True)), sa.Column('active', sa.Boolean, nullable=False), sa.UniqueConstraint('user_id','application_id'))
    op.create_table('download_audit', sa.Column('id', sa.Integer, primary_key=True), sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id'), nullable=False), sa.Column('release_id', sa.Integer, sa.ForeignKey('releases.id'), nullable=False), sa.Column('issued_at', sa.DateTime(timezone=True), nullable=False))
def downgrade():
    for table in ['download_audit','entitlements','releases','applications','sessions','users']: op.drop_table(table)
