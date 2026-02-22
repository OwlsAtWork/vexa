// Transcriber Factory - Creates appropriate transcriber service based on provider configuration.

import { log } from '../utils';
import { BotConfig } from '../types';
import { WhisperLiveService } from './whisperlive';
import { AWSTranscribeService } from './aws-transcribe';

/* Base interface that all transcriber services must implement */
export interface TranscriberService {
  initialize(config: BotConfig): Promise<boolean>;
  connect(
    config: BotConfig,
    onTranscription: (data: any) => void,
    onError: (error: any) => void,
    onClose: (event?: any) => void
  ): Promise<any>;

  sendAudio(socket: any, audioData: Buffer): Promise<void>;
  close(socket: any): Promise<void>;
  getProvider(): string;
  sendSpeakerEvent?(
    eventType: string,
    participantName: string,
    participantId: string,
    relativeTimestampMs: number,
    botConfig: BotConfig
  ): boolean;
}

/* Factory class to create transcriber service instances */
export class TranscriberFactory {
  /* Create a transcriber service based on environment configuration. It @returns TranscriberService instance */
  static create(): TranscriberService {
    const provider = (process.env.TRANSCRIBER_PROVIDER || 'whisper_live').toLowerCase();
    log(`[TranscriberFactory] Creating transcriber for provider: ${provider}`);
    switch (provider) {
      case 'aws':
        log('[TranscriberFactory] Initializing AWS Transcribe');
        return new AWSTranscribeService();

      case 'whisper_live':
      default:
        log('[TranscriberFactory] Initializing WhisperLive (default)');
        return new WhisperLiveService({});
    }
  }

  /* Get transcriber configuration from environment */
  static getConfig(): any {
    const configStr = process.env.TRANSCRIBER_CONFIG || '{}';
    try {
      return JSON.parse(configStr);
    } catch (error) {
      log(`[TranscriberFactory] Failed to parse TRANSCRIBER_CONFIG: ${error}`);
      return {};
    }
  }

  /* Get S3 configuration from environment */
  static getS3Config(): { bucketName?: string; region?: string; prefix?: string } {
    return {
      bucketName: process.env.S3_BUCKET_NAME,
      region: process.env.S3_REGION || 'us-east-1',
      prefix: process.env.S3_PREFIX || '',
    };
  }
}
