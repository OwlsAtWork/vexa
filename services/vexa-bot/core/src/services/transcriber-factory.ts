/**
 * Transcriber Factory
 *
 * Creates appropriate transcriber service based on provider configuration.
 * Supports: WhisperLive (default), AWS Transcribe, Deepgram, ElevenLabs
 */

import { log } from '../utils';
import { BotConfig } from '../types';
import { WhisperLiveService } from './whisperlive';
import { AWSTranscribeService } from './aws-transcribe';
import { DeepgramService } from './deepgram';
import { ElevenLabsService } from './elevenlabs';

/**
 * Base interface that all transcriber services must implement
 */
export interface TranscriberService {
  /**
   * Initialize the transcriber service
   */
  initialize(config: BotConfig): Promise<boolean>;

  /**
   * Connect to the transcription service
   */
  connect(
    config: BotConfig,
    onTranscription: (data: any) => void,
    onError: (error: any) => void,
    onClose: (event?: any) => void
  ): Promise<any>;

  /**
   * Send audio data to the transcriber
   */
  sendAudio(socket: any, audioData: Buffer): Promise<void>;

  /**
   * Close the transcriber connection
   */
  close(socket: any): Promise<void>;

  /**
   * Get transcriber provider name
   */
  getProvider(): string;
}

/**
 * Factory class to create transcriber service instances
 */
export class TranscriberFactory {
  /**
   * Create a transcriber service based on environment configuration
   *
   * Priority for provider selection:
   * 1. TRANSCRIBER_PROVIDER env var (set by bot-manager via /v2/bots API)
   * 2. Falls back to WhisperLive (default)
   *
   * @returns TranscriberService instance
   */
  static create(): TranscriberService {
    const provider = (process.env.TRANSCRIBER_PROVIDER || 'whisper_live').toLowerCase();

    log(`[TranscriberFactory] Creating transcriber for provider: ${provider}`);

    switch (provider) {
      case 'aws':
        log('[TranscriberFactory] Initializing AWS Transcribe');
        return new AWSTranscribeService();

      case 'deepgram':
        log('[TranscriberFactory] Initializing Deepgram');
        return new DeepgramService();

      case 'elevenlabs':
        log('[TranscriberFactory] Initializing ElevenLabs');
        return new ElevenLabsService();

      case 'whisper_live':
      default:
        log('[TranscriberFactory] Initializing WhisperLive (default)');
        return new WhisperLiveService({});
    }
  }

  /**
   * Get transcriber configuration from environment
   */
  static getConfig(): any {
    const configStr = process.env.TRANSCRIBER_CONFIG || '{}';
    try {
      return JSON.parse(configStr);
    } catch (error) {
      log(`[TranscriberFactory] Failed to parse TRANSCRIBER_CONFIG: ${error}`);
      return {};
    }
  }

  /**
   * Get S3 configuration from environment
   */
  static getS3Config(): { bucketName?: string; region?: string; prefix?: string } {
    return {
      bucketName: process.env.S3_BUCKET_NAME,
      region: process.env.S3_REGION || 'us-east-1',
      prefix: process.env.S3_PREFIX || '',
    };
  }
}
