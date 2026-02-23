from datetime import datetime, timezone
import json
import logging
import os
import boto3
import httpx
from botocore.exceptions import ClientError
from sqlalchemy.ext.asyncio import AsyncSession
from shared_models.models import Meeting

logger = logging.getLogger(__name__)

ACCESS_KEY_KEYWORD = "access_key"
AWS_ACCESS_KEY = "AWS_ACCESS_KEY_ID"
AWS_REGION = "AWS_REGION"
AWS_SECRET_KEY = "AWS_SECRET_ACCESS_KEY"
AWS_SESSION_TOKEN = "AWS_SESSION_TOKEN"
BUCKET_NAME_KEY = "bucket_name"
DEFAULT_AWS_REGION = "us-east-1"
DEFAULT_COLLECTOR_URL = "http://transcription-collector:8000"
ENCODING_UTF8 = "utf-8"
END_TIME_KEY = "end_time"
FILE_EXTENSION = ".json"
HTTP_STATUS_OK = 200
HTTP_TIMEOUT_SECONDS = 30.0
MEETING_ID_KEY = "meeting_id"
PATH_SEPARATOR = "/"
PLATFORM_KEY = "platform"
PLATFORM_MEETING_ID_KEY = "platform_meeting_id"
PREFIX_KEY = "prefix"
REGION_KEY = "region"
S3_CONTENT_TYPE_JSON = "application/json"
S3_KEY_PREFIX = "vexa_transcripts"
S3_SERVICE_NAME = "s3"
S3_URI_PREFIX = "s3://"
SECRET_KEY_KEYWORD ="secret_key"
SEGMENTS_KEY = "segments"
SESSION_TOKEN_KEYWORD = "session_token"
START_TIME_KEY = "start_time"
TIMESTAMP_FORMAT = "%Y%m%d_%H%M%S"
TRANSCRIPTION_COLLECTOR_URL_KEY = "TRANSCRIPTION_COLLECTOR_URL"
TRANSCRIPT_BUCKET_KEY = "TRANSCRIPT_S3_BUCKET"
TRANSCRIPT_ENDPOINT_PREFIX = "/internal/transcripts/"
TRANSCRIPT_LOCATION_KEY = "transcript_s3_location"
UPLOADED_AT_KEY = "uploaded_at"
USER_ID_KEY = "user_id"

def get_aws_config(meeting: Meeting) -> dict:
    """ Load AWS S3 configuration from user-provided infomation via API """
    s3_config = meeting.data.get('s3_config', {}) if meeting.data else {}

    access_key = os.getenv(AWS_ACCESS_KEY)
    bucket_name = s3_config.get(BUCKET_NAME_KEY) or os.getenv(TRANSCRIPT_BUCKET_KEY)
    prefix = s3_config.get(PREFIX_KEY, '')
    region = s3_config.get(REGION_KEY) or os.getenv(AWS_REGION, DEFAULT_AWS_REGION)
    secret_key = os.getenv(AWS_SECRET_KEY)
    session_token = os.getenv(AWS_SESSION_TOKEN)

    return {
        BUCKET_NAME_KEY: bucket_name,
        REGION_KEY: region,
        PREFIX_KEY: prefix,
        ACCESS_KEY_KEYWORD: access_key,
        SECRET_KEY_KEYWORD: secret_key,
        SESSION_TOKEN_KEYWORD: session_token
    }

def build_s3_client(cfg: dict):
    """ Create a boto3 S3 client using provided configuration. """
    if not cfg.get(ACCESS_KEY_KEYWORD) or not cfg.get(SECRET_KEY_KEYWORD):
        raise ValueError("Missing AWS credentials")

    client_args = {
        "service_name": S3_SERVICE_NAME,
        "aws_access_key_id": cfg[ACCESS_KEY_KEYWORD],
        "aws_secret_access_key": cfg[SECRET_KEY_KEYWORD],
        "region_name": cfg[REGION_KEY],
    }
    if cfg.get(SESSION_TOKEN_KEYWORD):
        client_args["aws_session_token"] = cfg[SESSION_TOKEN_KEYWORD]
    return boto3.client(**client_args)

async def fetch_transcript(meeting_id: str) -> list | None:
    """ Retrieve transcript segments for a meeting from the transcription service. """
    collector_base_url = os.getenv(
        TRANSCRIPTION_COLLECTOR_URL_KEY,
        DEFAULT_COLLECTOR_URL
    )
    collector_url = f"{collector_base_url}{TRANSCRIPT_ENDPOINT_PREFIX}{meeting_id}"
    logger.debug("Fetching transcript from %s", collector_url)

    async with httpx.AsyncClient() as client:
        response = await client.get(collector_url, timeout=HTTP_TIMEOUT_SECONDS)

    if response.status_code != HTTP_STATUS_OK:
        logger.debug("Transcript fetch failed (%s)", response.status_code)
        return None
    return response.json()

def build_transcript_payload(meeting: Meeting, segments: list) -> str:
    """ Construct the JSON payload for transcript storage. """
    payload = {
        MEETING_ID_KEY: meeting.id,
        USER_ID_KEY: meeting.user_id,
        PLATFORM_KEY: meeting.platform,
        PLATFORM_MEETING_ID_KEY: meeting.platform_specific_id,
        START_TIME_KEY: meeting.start_time.isoformat() if meeting.start_time else None,
        END_TIME_KEY: meeting.end_time.isoformat() if meeting.end_time else None,
        SEGMENTS_KEY: segments,
        UPLOADED_AT_KEY: datetime.now(timezone.utc).isoformat(),
    }

    return json.dumps(payload, indent=2)

def generate_s3_key(meeting: Meeting, prefix: str = '') -> str:
    """ Generate an S3 object key for storing a transcript. Respects user-provided prefix from s3_config. """
    timestamp = datetime.now(timezone.utc).strftime(TIMESTAMP_FORMAT)
    base_key = f"{S3_KEY_PREFIX}{PATH_SEPARATOR}{meeting.user_id}{PATH_SEPARATOR}{meeting.id}_{timestamp}{FILE_EXTENSION}"
    if prefix:
        prefix = prefix.rstrip(PATH_SEPARATOR) + PATH_SEPARATOR
        return f"{prefix}{base_key}"
    return base_key

def upload_to_s3(client, bucket: str, key: str, body: str, meeting: Meeting):
    """ Upload transcript data to an S3 bucket. """
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=body.encode(ENCODING_UTF8),
        ContentType=S3_CONTENT_TYPE_JSON,
        Metadata={
            MEETING_ID_KEY: str(meeting.id),
            USER_ID_KEY: str(meeting.user_id),
            PLATFORM_KEY: meeting.platform,
        },
    )

async def run(meeting: Meeting, db: AsyncSession):
    """ Uploads the completed transcript to S3 after a meeting ends. """
    meeting_id = meeting.id
    logger.debug(f"Starting S3 transcript upload for meeting {meeting_id}")
    cfg = get_aws_config(meeting)
    if not cfg[BUCKET_NAME_KEY]:
        logger.debug(f"S3 bucket not configured. Skipping transcript upload for meeting {meeting_id}")
        return

    try:
        s3_client = build_s3_client(cfg)
    except Exception as e:
        raise RuntimeError(f"S3 client creation failed: {e}") from e

    try:
        transcription_segments = await fetch_transcript(meeting_id)
    except Exception as e:
        raise RuntimeError(f"Failed to fetch transcript for meeting {meeting_id}: {e}") from e

    if not transcription_segments:
        logger.debug(f"No transcript segments for meeting {meeting_id}. Nothing to upload.")
        return

    transcript_json = build_transcript_payload(meeting, transcription_segments)
    s3_key = generate_s3_key(meeting, cfg.get(PREFIX_KEY, ''))

    try:
        upload_to_s3(
            client=s3_client,
            bucket=cfg[BUCKET_NAME_KEY],
            key=s3_key,
            body=transcript_json,
            meeting=meeting,
        )
    except ClientError as e:
        raise RuntimeError(f"Failed to upload transcript to S3 for meeting {meeting_id}: {e}") from e

    location = f"{S3_URI_PREFIX}{cfg[BUCKET_NAME_KEY]}/{s3_key}"
    logger.info(f"Successfully uploaded transcript for meeting {meeting_id} to {location}")
    if not meeting.data:
        meeting.data = {}
    meeting.data[TRANSCRIPT_LOCATION_KEY] = location