import boto3
from botocore.config import Config
from .config import settings

def client(public=False):
    return boto3.client('s3', endpoint_url=(settings.s3_public_endpoint or settings.s3_endpoint) if public else settings.s3_endpoint,
        region_name=settings.s3_region, aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}, connect_timeout=5, read_timeout=30, retries={'max_attempts': 3}))
def download_url(release):
    client().head_object(Bucket=settings.s3_bucket, Key=release.object_key)
    return client(public=True).generate_presigned_url('get_object', Params={
        'Bucket': settings.s3_bucket, 'Key': release.object_key,
        'ResponseContentDisposition': f'attachment; filename="{release.filename}"'}, ExpiresIn=settings.download_seconds)
