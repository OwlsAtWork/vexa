/**
 * ElevenLabs Service
 *
 * Implements real-time transcription using ElevenLabs Conversational AI
 */

import { log } from '../utils';
import { BotConfig } from '../types';
import { TranscriberService } from './transcriber-factory';

/**
 * ElevenLabs Service Implementation
 */
export class ElevenLabsService implements TranscriberService {
  private ws: any = null;
  private isConnected: boolean = false;
  private config: any = {};

  constructor() {
    log('[ElevenLabs] Service created');
  }

  /**
   * Initialize ElevenLabs client
   */
  async initialize(config: BotConfig): Promise<boolean> {
    try {
      // Parse transcriber configuration
      const transcriberConfig = this.parseConfig();
      this.config = transcriberConfig;

      log(`[ElevenLabs] Initializing with config: ${JSON.stringify({
        model: transcriberConfig.model,
        language: transcriberConfig.language,
        identifyLanguage: transcriberConfig.identifyLanguage,
      })}`);

      // Validate ElevenLabs API key
      if (!process.env.ELEVENLABS_API_KEY) {
        log('[ElevenLabs] ERROR: ELEVENLABS_API_KEY not found in environment');
        return false;
      }

      log('[ElevenLabs] Client initialized successfully');
      return true;
    } catch (error: any) {
      log(`[ElevenLabs] Initialization error: ${error.message}`);
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
      log('[ElevenLabs] Failed to parse config, using defaults');
    }

    return {
      model: config.model || 'scribe_v2_realtime',
      language: config.language || 'en',
      identifyLanguage: config.identify_language === true,
      upsampleTo16k: config.upsample_to_16k === true,
      sampleRate: config.sampling_rate || 16000,
    };
  }

  /**
   * Connect to ElevenLabs and start transcription
   */
  async connect(
    config: BotConfig,
    onTranscription: (data: any) => void,
    onError: (error: any) => void,
    onClose: (event?: any) => void
  ): Promise<any> {
    try {
      log('[ElevenLabs] Starting WebSocket connection...');

      // ElevenLabs WebSocket endpoint
      const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.ELEVENLABS_AGENT_ID || 'default'}`;

      // Create WebSocket connection
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
        },
      } as any);

      // Set up event handlers
      this.ws.onopen = () => {
        log('[ElevenLabs] Connection opened');
        this.isConnected = true;

        // Send initial configuration
        this.ws.send(
          JSON.stringify({
            type: 'config',
            config: {
              model: this.config.model,
              language: this.config.language,
              sample_rate: this.config.sampleRate,
            },
          })
        );
      };

      this.ws.onmessage = (event: any) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'transcript' && data.text) {
            log(`[ElevenLabs] Transcription: ${data.text}`);

            // Format in WhisperLive-compatible format for unified callback
            const formattedData = {
              type: 'transcription',
              provider: 'elevenlabs',
              segments: [
                {
                  text: data.text,
                  start: data.start || 0,
                  end: data.end || 0,
                },
              ],
            };

            onTranscription(formattedData);
          }
        } catch (error: any) {
          log(`[ElevenLabs] Error processing message: ${error.message}`);
        }
      };

      this.ws.onerror = (error: any) => {
        log(`[ElevenLabs] Error: ${error.message}`);
        onError(error);
      };

      this.ws.onclose = (event: any) => {
        log('[ElevenLabs] Connection closed');
        this.isConnected = false;
        onClose(event);
      };

      log('[ElevenLabs] Connection established');
      return this.ws;
    } catch (error: any) {
      log(`[ElevenLabs] Connection error: ${error.message}`);
      onError(error);
      return null;
    }
  }

  /**
   * Send audio data to ElevenLabs
   */
  async sendAudio(socket: any, audioData: Buffer): Promise<void> {
    if (!this.isConnected || !this.ws) {
      log('[ElevenLabs] Not connected, cannot send audio');
      return;
    }

    try {
      // Send audio as binary data
      this.ws.send(audioData);
    } catch (error: any) {
      log(`[ElevenLabs] Error sending audio: ${error.message}`);
    }
  }

  /**
   * Close ElevenLabs connection
   */
  async close(socket: any): Promise<void> {
    log('[ElevenLabs] Closing connection');

    try {
      if (this.ws) {
        this.ws.close();
      }

      this.isConnected = false;
      log('[ElevenLabs] Connection closed');
    } catch (error: any) {
      log(`[ElevenLabs] Error closing: ${error.message}`);
    }
  }

  /**
   * Get provider name
   */
  getProvider(): string {
    return 'elevenlabs';
  }
}
