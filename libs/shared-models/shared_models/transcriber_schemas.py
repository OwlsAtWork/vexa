"""
Enhanced schemas for dynamic transcriber configuration.
Add these to your existing schemas.py or import from this file.
"""
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field, field_validator
from enum import Enum


class TranscriberProvider(str, Enum):
    """Supported transcription providers"""
    WHISPER_LIVE = "whisper_live"  # Default - existing implementation
    AWS = "aws"  # AWS Transcribe
    DEEPGRAM = "deepgram"  # Deepgram
    ELEVENLABS = "elevenlabs"  # ElevenLabs


class S3Config(BaseModel):
    """Configuration for S3 storage of transcriptions"""
    bucket_name: str = Field(..., description="S3 bucket name for storing transcriptions")
    region: Optional[str] = Field("us-east-1", description="AWS region for the S3 bucket")
    prefix: Optional[str] = Field(None, description="Optional prefix/folder path in the bucket (e.g., 'transcriptions/')")

    @field_validator('bucket_name')
    @classmethod
    def validate_bucket_name(cls, v):
        """Validate S3 bucket name format"""
        if not v or len(v) < 3 or len(v) > 63:
            raise ValueError("Bucket name must be between 3 and 63 characters")
        if not v[0].isalnum() or not v[-1].isalnum():
            raise ValueError("Bucket name must start and end with alphanumeric character")
        return v.lower()


class BaseTranscriberConfig(BaseModel):
    """Base configuration for all transcribers"""
    provider: TranscriberProvider = Field(..., description="Transcription provider to use")
    language: Optional[str] = Field(None, description="Language code (e.g., 'en', 'es'). If not specified, auto-detect")
    sampling_rate: int = Field(16000, description="Audio sampling rate in Hz (8000, 16000, 22050, etc.)")


class WhisperLiveConfig(BaseTranscriberConfig):
    """Configuration for WhisperLive (default transcriber)"""
    provider: TranscriberProvider = Field(TranscriberProvider.WHISPER_LIVE, description="Must be 'whisper_live'")
    task: Optional[str] = Field("transcribe", description="Task: 'transcribe' or 'translate'")
    # Add any WhisperLive-specific parameters here


class AWSTranscriberConfig(BaseTranscriberConfig):
    """Configuration for AWS Transcribe"""
    provider: TranscriberProvider = Field(TranscriberProvider.AWS, description="Must be 'aws'")
    identify_language: bool = Field(True, description="Enable automatic language identification")
    preferred_language: Optional[str] = Field("en-US", description="Preferred language for auto-detection")
    candidate_languages: Optional[List[str]] = Field(
        ["en-US", "es-ES"],
        description="List of candidate languages for auto-detection"
    )
    denoiser_enabled: bool = Field(False, description="Enable audio denoising")
    denoiser_type: Optional[str] = Field("rnnoise", description="Denoiser type: 'rnnoise' or 'deepfilter'")

    @field_validator('language')
    @classmethod
    def validate_language_format(cls, v):
        """Validate AWS language code format (e.g., en-US)"""
        if v and '-' not in v:
            raise ValueError(f"AWS language code must be in format 'en-US', got: {v}")
        return v


class DeepgramTranscriberConfig(BaseTranscriberConfig):
    """Configuration for Deepgram"""
    provider: TranscriberProvider = Field(TranscriberProvider.DEEPGRAM, description="Must be 'deepgram'")
    model: Optional[str] = Field("nova-2", description="Deepgram model to use (e.g., 'nova-2', 'whisper-large')")
    tier: Optional[str] = Field(None, description="Deepgram tier (e.g., 'nova', 'enhanced')")
    punctuate: bool = Field(True, description="Enable automatic punctuation")
    diarize: bool = Field(False, description="Enable speaker diarization")


class ElevenLabsTranscriberConfig(BaseTranscriberConfig):
    """Configuration for ElevenLabs"""
    provider: TranscriberProvider = Field(TranscriberProvider.ELEVENLABS, description="Must be 'elevenlabs'")
    model: Optional[str] = Field("scribe_v2_realtime", description="ElevenLabs model to use")
    identify_language: bool = Field(True, description="Enable automatic language identification")
    upsample_to_16k: bool = Field(False, description="Upsample 8kHz MULAW to 16kHz PCM (better for non-English)")


class TranscriberConfig(BaseModel):
    """Union type for all transcriber configurations"""
    # This will hold the actual transcriber config
    config: Dict[str, Any] = Field(..., description="Transcriber-specific configuration")

    @classmethod
    def from_provider_config(cls, provider_config: BaseTranscriberConfig):
        """Create TranscriberConfig from a specific provider config"""
        return cls(config=provider_config.model_dump())

    def get_provider(self) -> TranscriberProvider:
        """Extract provider from config"""
        return TranscriberProvider(self.config.get("provider"))


class MeetingCreateEnhanced(BaseModel):
    """
    Enhanced meeting creation request with transcriber and S3 configuration.

    This extends the basic meeting creation to support:
    - Dynamic transcriber selection (WhisperLive, AWS, Deepgram, ElevenLabs)
    - Custom S3 bucket configuration for transcription storage
    - Provider-specific transcription parameters
    """
    # Meeting configuration
    platform: str = Field(..., description="Platform: 'google_meet', 'zoom', or 'teams'")
    native_meeting_id: str = Field(..., description="Platform-specific meeting ID")
    passcode: Optional[str] = Field(None, description="Meeting passcode (Teams only)")
    bot_name: Optional[str] = Field(None, description="Optional bot display name")

    # S3 configuration
    s3_config: S3Config = Field(..., description="S3 bucket configuration for transcription storage")

    # Transcriber configuration (using discriminated union pattern)
    transcriber_config: Dict[str, Any] = Field(
        ...,
        description="Transcriber configuration. Must include 'provider' field"
    )

    @field_validator('transcriber_config')
    @classmethod
    def validate_transcriber_config(cls, v):
        """Validate transcriber configuration has provider field"""
        if 'provider' not in v:
            raise ValueError("transcriber_config must include 'provider' field")

        provider = v.get('provider')
        valid_providers = [p.value for p in TranscriberProvider]
        if provider not in valid_providers:
            raise ValueError(
                f"Invalid provider '{provider}'. Must be one of: {', '.join(valid_providers)}"
            )

        return v

    def get_transcriber_provider(self) -> TranscriberProvider:
        """Extract transcriber provider from config"""
        return TranscriberProvider(self.transcriber_config['provider'])


# Response models
class MeetingResponseEnhanced(BaseModel):
    """Enhanced meeting response including transcriber info"""
    meeting_id: str
    platform: str
    native_meeting_id: str
    status: str
    transcriber_provider: str
    s3_bucket: str
    created_at: str


# Example usage documentation
EXAMPLE_REQUESTS = {
    "whisper_live": {
        "platform": "google_meet",
        "native_meeting_id": "abc-defg-hij",
        "s3_config": {
            "bucket_name": "my-transcriptions",
            "region": "us-east-1",
            "prefix": "meetings/"
        },
        "transcriber_config": {
            "provider": "whisper_live",
            "language": "en",
            "task": "transcribe",
            "sampling_rate": 16000
        }
    },
    "aws": {
        "platform": "teams",
        "native_meeting_id": "1234567890",
        "passcode": "abc123XYZ",
        "s3_config": {
            "bucket_name": "my-transcriptions",
            "region": "us-east-1"
        },
        "transcriber_config": {
            "provider": "aws",
            "identify_language": True,
            "preferred_language": "en-US",
            "candidate_languages": ["en-US", "es-ES", "fr-FR"],
            "denoiser_enabled": True,
            "sampling_rate": 16000
        }
    },
    "deepgram": {
        "platform": "zoom",
        "native_meeting_id": "123-456-789",
        "s3_config": {
            "bucket_name": "company-transcriptions",
            "prefix": "zoom-meetings/"
        },
        "transcriber_config": {
            "provider": "deepgram",
            "language": "en",
            "model": "nova-2",
            "punctuate": True,
            "diarize": True,
            "sampling_rate": 16000
        }
    },
    "elevenlabs": {
        "platform": "google_meet",
        "native_meeting_id": "xyz-abcd-efg",
        "s3_config": {
            "bucket_name": "ai-transcriptions"
        },
        "transcriber_config": {
            "provider": "elevenlabs",
            "language": "es",
            "identify_language": False,
            "upsample_to_16k": True,
            "sampling_rate": 8000
        }
    }
}
