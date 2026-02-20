/**
 * Deepgram Service
 *
 * Implements real-time transcription using Deepgram API
 */

import { log } from '../utils';
import { BotConfig } from '../types';
import { TranscriberService } from './transcriber-factory';

// Deepgram SDK imports (will be installed via npm)
let createClient: any;
let LiveTranscriptionEvents: any;

/**
 * Deepgram Service Implementation
 */
export class DeepgramService implements TranscriberService {
  private client: any = null;
  private connection: any = null;
  private isConnected: boolean = false;
  private config: any = {};

  constructor() {
    log('[Deepgram] Service created');
  }

  /**
   * Initialize Deepgram client
   */
  async initialize(config: BotConfig): Promise<boolean> {
    try {
      // Parse transcriber configuration
      const transcriberConfig = this.parseConfig();
      this.config = transcriberConfig;

      log(`[Deepgram] Initializing with config: ${JSON.stringify({
        model: transcriberConfig.model,
        language: transcriberConfig.language,
        punctuate: transcriberConfig.punctuate,
        diarize: transcriberConfig.diarize,
      })}`);

      // Validate Deepgram API key
      if (!process.env.DEEPGRAM_API_KEY) {
        log('[Deepgram] ERROR: DEEPGRAM_API_KEY not found in environment');
        return false;
      }

      // Dynamic import of Deepgram SDK
      try {
        const deepgramSDK = await import('@deepgram/sdk');
        createClient = deepgramSDK.createClient;
        LiveTranscriptionEvents = deepgramSDK.LiveTranscriptionEvents;
      } catch (error) {
        log('[Deepgram] ERROR: Deepgram SDK not installed. Run: npm install @deepgram/sdk');
        return false;
      }

      // Create Deepgram client
      this.client = createClient(process.env.DEEPGRAM_API_KEY);

      log('[Deepgram] Client initialized successfully');
      return true;
    } catch (error: any) {
      log(`[Deepgram] Initialization error: ${error.message}`);
      return false;
    }
  }

  /**
   * Parse transcriber configuration from environment
   */
  private parseConfig() {
    const configStr = process.env.TRANSCRIBER_CONFIG || '{}';
    let config: any = {};

    try {
      config = JSON.parse(configStr);
    } catch (error) {
      log('[Deepgram] Failed to parse config, using defaults');
    }

    return {
      model: config.model || 'nova-2',
      language: config.language || 'en',
      punctuate: config.punctuate !== false,
      diarize: config.diarize === true,
      sampleRate: config.sampling_rate || 16000,
      tier: config.tier,
    };
  }

  /**
   * Connect to Deepgram and start live transcription
   */
  async connect(
    config: BotConfig,
    onTranscription: (data: any) => void,
    onError: (error: any) => void,
    onClose: (event?: any) => void
  ): Promise<any> {
    try {
      if (!this.client) {
        throw new Error('Deepgram client not initialized');
      }

      log('[Deepgram] Starting live transcription...');

      // Configure live transcription options
      const options: any = {
        model: this.config.model,
        language: this.config.language,
        punctuate: this.config.punctuate,
        diarize: this.config.diarize,
        encoding: 'linear16',
        sample_rate: this.config.sampleRate,
        channels: 1,
      };

      // Add tier if specified
      if (this.config.tier) {
        options.tier = this.config.tier;
      }

      // Create live connection
      this.connection = this.client.listen.live(options);

      // Set up event handlers
      this.connection.on(LiveTranscriptionEvents.Open, () => {
        log('[Deepgram] Connection opened');
        this.isConnected = true;
      });

      this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
        try {
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          const isFinal = data.is_final;

          if (transcript && isFinal) {
            log(`[Deepgram] Transcription: ${transcript}`);

            // Format in WhisperLive-compatible format for unified callback
            const formattedData = {
              type: 'transcription',
              provider: 'deepgram',
              segments: [
                {
                  text: transcript,
                  start: data.start || 0,
                  end: data.start + data.duration || 0,
                },
              ],
            };

            onTranscription(formattedData);
          }
        } catch (error: any) {
          log(`[Deepgram] Error processing transcript: ${error.message}`);
        }
      });

      this.connection.on(LiveTranscriptionEvents.Error, (error: any) => {
        log(`[Deepgram] Error: ${error.message}`);
        onError(error);
      });

      this.connection.on(LiveTranscriptionEvents.Close, (event: any) => {
        log('[Deepgram] Connection closed');
        this.isConnected = false;
        onClose(event);
      });

      log('[Deepgram] Connection established');
      return this.connection;
    } catch (error: any) {
      log(`[Deepgram] Connection error: ${error.message}`);
      onError(error);
      return null;
    }
  }

  /**
   * Send audio data to Deepgram
   */
  async sendAudio(socket: any, audioData: Buffer): Promise<void> {
    if (!this.isConnected || !this.connection) {
      log('[Deepgram] Not connected, cannot send audio');
      return;
    }

    try {
      this.connection.send(audioData);
    } catch (error: any) {
      log(`[Deepgram] Error sending audio: ${error.message}`);
    }
  }

  /**
   * Close Deepgram connection
   */
  async close(socket: any): Promise<void> {
    log('[Deepgram] Closing connection');

    try {
      if (this.connection) {
        this.connection.finish();
      }

      this.isConnected = false;
      log('[Deepgram] Connection closed');
    } catch (error: any) {
      log(`[Deepgram] Error closing: ${error.message}`);
    }
  }

  /**
   * Get provider name
   */
  getProvider(): string {
    return 'deepgram';
  }
}
