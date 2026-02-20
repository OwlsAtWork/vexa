/**
 * AWS Transcribe Service
 *
 * Implements real-time transcription using AWS Transcribe Streaming API
 */

import { log } from '../utils';
import { BotConfig } from '../types';
import { TranscriberService } from './transcriber-factory';

// AWS SDK imports (will be installed via npm)
// We'll use dynamic imports to avoid breaking if SDK isn't installed yet
let TranscribeStreamingClient: any;
let StartStreamTranscriptionCommand: any;

/**
 * AWS Transcribe Service Implementation
 */
export class AWSTranscribeService implements TranscriberService {
  private client: any = null;
  private audioStream: any = null;
  private transcriptionStream: any = null;
  private isConnected: boolean = false;
  private config: any = {};

  constructor() {
    log('[AWSTranscribe] Service created');
  }

  /**
   * Initialize AWS Transcribe client
   */
  async initialize(config: BotConfig): Promise<boolean> {
    try {
      // Parse transcriber configuration
      const transcriberConfig = this.parseConfig();
      this.config = transcriberConfig;

      // Log environment variable status
      log(`[AWSTranscribe] Environment check:`);
      log(`  AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID ? '✓ set' : '✗ MISSING'}`);
      log(`  AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY ? '✓ set' : '✗ MISSING'}`);
      log(`  AWS_SESSION_TOKEN: ${process.env.AWS_SESSION_TOKEN ? '✓ set' : '(not set - optional)'}`);
      log(`  AWS_REGION: ${process.env.AWS_REGION || '(not set, will default to us-east-1)'}`);
      log(`  TRANSCRIBER_CONFIG: ${process.env.TRANSCRIBER_CONFIG || '(not set, using defaults)'}`);

      log(`[AWSTranscribe] Parsed configuration: ${JSON.stringify({
        region: process.env.AWS_REGION || 'us-east-1',
        languageCode: transcriberConfig.languageCode,
        sampleRate: transcriberConfig.sampleRate,
        identifyLanguage: transcriberConfig.identifyLanguage,
        candidateLanguages: transcriberConfig.candidateLanguages,
        denoiserEnabled: transcriberConfig.denoiserEnabled,
        denoiserType: transcriberConfig.denoiserType
      }, null, 2)}`);

      // Validate AWS credentials
      if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
        log('[AWSTranscribe] ❌ ERROR: AWS credentials not found in environment');
        log('[AWSTranscribe] Required: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
        return false;
      }

      // Dynamic import of AWS SDK
      try {
        const awsSDK = await import('@aws-sdk/client-transcribe-streaming');
        TranscribeStreamingClient = awsSDK.TranscribeStreamingClient;
        StartStreamTranscriptionCommand = awsSDK.StartStreamTranscriptionCommand;
      } catch (error) {
        log('[AWSTranscribe] ERROR: AWS SDK not installed. Run: npm install @aws-sdk/client-transcribe-streaming');
        return false;
      }

      // Create AWS Transcribe client
      this.client = new TranscribeStreamingClient({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        },
      });

      log('[AWSTranscribe] Client initialized successfully');
      return true;
    } catch (error: any) {
      log(`[AWSTranscribe] Initialization error: ${error.message}`);
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
      log('[AWSTranscribe] Failed to parse config, using defaults');
    }

    return {
      languageCode: config.preferred_language || 'en-US',
      sampleRate: config.sampling_rate || 16000,
      identifyLanguage: config.identify_language === true,
      candidateLanguages: config.candidate_languages || ['en-US'],
      denoiserEnabled: config.denoiser_enabled === true,
      denoiserType: config.denoiser_type || 'rnnoise',
    };
  }

  /**
   * Connect to AWS Transcribe and start streaming transcription
   */
  async connect(
    config: BotConfig,
    onTranscription: (data: any) => void,
    onError: (error: any) => void,
    onClose: (event?: any) => void
  ): Promise<any> {
    // Define params outside try block so it's accessible in catch for error logging
    let params: any = {};

    try {
      if (!this.client) {
        throw new Error('AWS Transcribe client not initialized');
      }

      log('[AWSTranscribe] Starting stream transcription...');

      // Create async generator for audio stream
      const audioStreamGenerator = this.createAudioStreamGenerator();

      log('[AWSTranscribe] Audio stream generator created, preparing connection to AWS...');

      // Build transcription request parameters
      params = {
        MediaSampleRateHertz: this.config.sampleRate,
        MediaEncoding: 'pcm',
        AudioStream: audioStreamGenerator,
      };

      // Language configuration: IdentifyLanguage and LanguageCode are mutually exclusive
      if (this.config.identifyLanguage && this.config.candidateLanguages && this.config.candidateLanguages.length >= 2) {
        // Only enable auto-detection if explicitly requested AND multiple languages provided
        params.IdentifyLanguage = true;
        params.LanguageOptions = this.config.candidateLanguages.join(','); // AWS expects comma-separated string
        log(`[AWSTranscribe] Language auto-detection enabled with options: ${this.config.candidateLanguages.join(', ')}`);
      } else {
        // Use fixed language code (preferred language or first candidate)
        const fixedLanguage = this.config.languageCode || (this.config.candidateLanguages && this.config.candidateLanguages[0]) || 'en-US';
        params.LanguageCode = fixedLanguage;
        log(`[AWSTranscribe] Using fixed language code: ${fixedLanguage}`);
      }

      // Create streaming command
      const command = new StartStreamTranscriptionCommand(params);

      // Start transcription
      const responsePromise = this.client.send(command);

      log('[AWSTranscribe] Stream started successfully');
      this.isConnected = true;

      // Handle transcription results
      responsePromise
        .then((response:any) => {
          this.handleTranscriptStream(response.TranscriptResultStream, onTranscription, onError);
        })
        .catch(onError);
        
      return {
        audioStream: this.audioStream,
        transcriptionStream: this.transcriptionStream,
      };
    } catch (error: any) {
      // Ensure connection flag is reset on failure
      this.isConnected = false;

      log(`[AWSTranscribe] ❌ Connection error: ${error.message || error}`);

      // Detect deserialization errors specifically
      const errorMessage = error.message || String(error);
      const isDeserializationError = errorMessage.toLowerCase().includes('deseriali') ||
                                     error.name === 'DeserializationError' ||
                                     error.__type === 'SerializationException';

      if (isDeserializationError) {
        log(`[AWSTranscribe] ⚠️  DESERIALIZATION ERROR - Invalid parameter format detected!`);
        log(`[AWSTranscribe] This usually means AWS rejected the request parameters.`);
        log(`[AWSTranscribe] Sent parameters: ${JSON.stringify({
          LanguageCode: params.LanguageCode,
          IdentifyLanguage: params.IdentifyLanguage,
          LanguageOptions: params.LanguageOptions,
          MediaSampleRateHertz: params.MediaSampleRateHertz,
          MediaEncoding: params.MediaEncoding
        })}`);
        log(`[AWSTranscribe] Common fixes:`);
        log(`[AWSTranscribe]   - LanguageCode must be valid AWS language code (e.g., en-US, es-ES)`);
        log(`[AWSTranscribe]   - LanguageOptions must be comma-separated string when IdentifyLanguage=true`);
        log(`[AWSTranscribe]   - MediaSampleRateHertz must be 8000, 16000, 32000, 44100, or 48000`);
      }

      // Log all error properties to debug
      log(`[AWSTranscribe] Error keys: ${Object.keys(error).join(', ')}`);

      if (error.$response) {
        log(`[AWSTranscribe] Response status: ${error.$response.statusCode}`);
        log(`[AWSTranscribe] Response headers: ${JSON.stringify(error.$response.headers)}`);
        log(`[AWSTranscribe] Response body: ${JSON.stringify(error.$response.body)}`);
      }

      // Try to access $metadata which AWS SDK v3 uses
      if (error.$metadata) {
        log(`[AWSTranscribe] Error metadata: ${JSON.stringify(error.$metadata)}`);
      }

      // Log the full error object structure
      try {
        log(`[AWSTranscribe] Full error object: ${JSON.stringify(error, null, 2)}`);
      } catch (stringifyError) {
        log(`[AWSTranscribe] Could not stringify error object`);
      }

      if (error.stack) {
        log(`[AWSTranscribe] Error stack: ${error.stack}`);
      }

      onError(error);

      // Return socket reference to allow audio buffering (connection will retry)
      log('[AWSTranscribe] Returning socket reference for audio buffering despite connection error');
      throw error;
    }
  }

  /**
   * Create async generator for audio streaming
   */
  private createAudioStreamGenerator() {
    const audioChunks: Buffer[] = [];
    let resolveNext: any = null;

    // Store audio stream reference
    let chunkCount = 0;
    this.audioStream = {
      write: (chunk: Buffer) => {
        audioChunks.push(chunk);
        chunkCount++;
        if (chunkCount % 100 === 0) {
          log(`[AWSTranscribe] Received ${chunkCount} audio chunks (queue size: ${audioChunks.length})`);
        }
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      },
      end: () => {
        audioChunks.push(null as any); // Signal end
        log(`[AWSTranscribe] Audio stream ended after ${chunkCount} chunks`);
        if (resolveNext) {
          resolveNext();
        }
      },
    };

    // Async generator that yields audio chunks
    let yieldCount = 0;
    return (async function* () {
      try {
        log('[AWSTranscribe] Audio generator started');
        while (true) {
          // Wait for chunks to be available
          while (audioChunks.length === 0) {
            await new Promise(r => setTimeout(r, 20));

            yield {
              AudioEvent: {
                AudioChunk: new Uint8Array(320)
              }
            };
          }

          const chunk = audioChunks.shift();
          if (!chunk || chunk === null) {
            log('[AWSTranscribe] Audio generator reached end of stream');
            break; // End of stream
          }

          // Convert Buffer to Uint8Array for AWS SDK v3
          const uint8Array = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          yieldCount++;
          if (yieldCount === 1 || yieldCount % 10 === 0) {
            log(`[AWSTranscribe] Yielding chunk ${yieldCount} to AWS (${uint8Array.byteLength} bytes, queue: ${audioChunks.length})`);
            // Add hex dump for first chunk to verify PCM16 format
            if (yieldCount === 1) {
              const preview = Array.from(uint8Array.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
              log(`[AWSTranscribe] First chunk hex (first 32 bytes): ${preview}`);
            }
          }
          yield { AudioEvent: { AudioChunk: uint8Array } };
          if (yieldCount === 1 || yieldCount % 10 === 0) {
            log(`[AWSTranscribe] Chunk ${yieldCount} yield completed, AWS SDK consumed it`);
          }
        }
        log(`[AWSTranscribe] Generator finished after ${yieldCount} chunks`);
      } catch (error: any) {
        log(`[AWSTranscribe] Generator error: ${error.message || error}`);
        throw error;
      }
    })();
  }

  /**
   * Handle transcription result stream from AWS
   */
  private async handleTranscriptStream(
    stream: AsyncIterable<any>,
    onTranscription: (data: any) => void,
    onError: (error: any) => void
  ) {
    try {
      for await (const event of stream) {
        if (event.TranscriptEvent?.Transcript?.Results) {
          for (const result of event.TranscriptEvent.Transcript.Results) {
            if (!result.IsPartial && result.Alternatives && result.Alternatives.length > 0) {
              const transcript = result.Alternatives[0].Transcript;

              if (transcript && transcript.trim()) {
                log(`[AWSTranscribe] Transcription: ${transcript}`);

                // Format in WhisperLive-compatible format for unified callback
                const formattedData = {
                  type: 'transcription',
                  provider: 'aws',
                  segments: [
                    {
                      text: transcript,
                      start: result.StartTime || 0,
                      end: result.EndTime || 0,
                    },
                  ],
                };

                onTranscription(formattedData);
              }
            }
          }
        }
      }
    } catch (error: any) {
      log(`[AWSTranscribe] Stream error: ${error.message}`);
      onError(error);
    }
  }

  /**
   * Send audio data to AWS Transcribe
   */
  async sendAudio(socket: any, audioData: Buffer): Promise<void> {
    if (!this.isConnected || !this.audioStream) {
      log('[AWSTranscribe] Not connected, cannot send audio');
      return;
    }

    try {
      this.audioStream.write(audioData);
    } catch (error: any) {
      log(`[AWSTranscribe] Error sending audio: ${error.message}`);
    }
  }

  /**
   * Close AWS Transcribe connection
   */
  async close(socket: any): Promise<void> {
    log('[AWSTranscribe] Closing connection');

    try {
      if (this.audioStream) {
        this.audioStream.end();
      }

      this.isConnected = false;
      log('[AWSTranscribe] Connection closed');
    } catch (error: any) {
      log(`[AWSTranscribe] Error closing: ${error.message}`);
    }
  }

  /**
   * Get provider name
   */
  getProvider(): string {
    return 'aws';
  }
}
