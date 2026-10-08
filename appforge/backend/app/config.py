from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')
    database_url: str
    public_origin: str = 'http://localhost:8080'
    cookie_secure: bool = True
    session_hours: int = Field(default=8, ge=1, le=24)
    s3_endpoint: str | None = None
    s3_public_endpoint: str | None = None
    s3_region: str = 'us-east-1'
    s3_bucket: str
    s3_access_key: str
    s3_secret_key: str
    download_seconds: int = Field(default=120, ge=30, le=300)
    @model_validator(mode='after')
    def validate_origin(self):
        if self.cookie_secure and not self.public_origin.startswith('https://'):
            raise ValueError('Secure cookies require an HTTPS PUBLIC_ORIGIN')
        if self.public_origin.endswith('/'):
            raise ValueError('PUBLIC_ORIGIN must not end with a slash')
        return self
settings = Settings()
