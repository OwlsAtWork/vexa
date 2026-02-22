/* AWS Transcribe Service - Implements real-time transcription using AWS Transcribe Streaming API */

import { log } from '../utils';
import { BotConfig } from '../types';
import { TranscriberService } from './transcriber-factory';

let TranscribeStreamingClient: any;
let StartStreamTranscriptionCommand: any;

/* AWS Transcribe Service Implementation */
export class AWSTranscribeService implements TranscriberService {
  private client: any = null;
  private audioStream: any = null;
  private transcriptionStream: any = null;
  private isConnected: boolean = false;
  private config: any = {};

  // Speaker event tracking for correlation with AWS labels
  private speakerEvents: Array<{
    timestamp: number;
    eventType: string;
    participantName: string;
    participantId: string;
  }> = [];
  private sessionStartTime: number = 0;

  constructor() {
    log('[AWSTranscribe] Service created');
  }

  async initialize(config: BotConfig): Promise<boolean> {
    try {
      const transcriberConfig = this.parseConfig();
      this.config = transcriberConfig;
      if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
        log('[AWSTranscribe] ERROR: AWS credentials not found in environment');
        log('[AWSTranscribe] Required: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
        return false;
      }

      try {
        const awsSDK = await import('@aws-sdk/client-transcribe-streaming');
        TranscribeStreamingClient = awsSDK.TranscribeStreamingClient;
        StartStreamTranscriptionCommand = awsSDK.StartStreamTranscriptionCommand;
      } catch (error) {
        log('[AWSTranscribe] ERROR: AWS SDK not installed. Run: npm install @aws-sdk/client-transcribe-streaming');
        return false;
      }

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

  /* Parse transcriber configuration from environment */
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

  /* Connect to AWS Transcribe and start streaming transcription */
  async connect(
    config: BotConfig,
    onTranscription: (data: any) => void,
    onError: (error: any) => void,
    onClose: (event?: any) => void
  ): Promise<any> {
    let params: any = {};
    try {
      if (!this.client) {
        throw new Error('AWS Transcribe client not initialized');
      }

      log('[AWSTranscribe] Starting stream transcription...');
      const audioStreamGenerator = this.createAudioStreamGenerator();
      log('[AWSTranscribe] Audio stream generator created, preparing connection to AWS...');

      // Build transcription request parameters
      params = {
        MediaSampleRateHertz: this.config.sampleRate,
        MediaEncoding: 'pcm',
        AudioStream: audioStreamGenerator,
        ShowSpeakerLabel: true,
        MaxSpeakerLabels: 10
      };

      // Language configuration: Only enable auto-detection if explicitly requested AND multiple languages provided
      if (this.config.identifyLanguage && this.config.candidateLanguages && this.config.candidateLanguages.length >= 2) {
        params.IdentifyLanguage = true;
        params.LanguageOptions = this.config.candidateLanguages.join(',');
        log(`[AWSTranscribe] Language auto-detection enabled with options: ${this.config.candidateLanguages.join(', ')}`);
      } else {
        const fixedLanguage = this.config.languageCode || (this.config.candidateLanguages && this.config.candidateLanguages[0]) || 'en-US';
        params.LanguageCode = fixedLanguage;
        log(`[AWSTranscribe] Using fixed language code: ${fixedLanguage}`);
      }

      const command = new StartStreamTranscriptionCommand(params);
      // Start transcription
      const responsePromise = this.client.send(command);
      log('[AWSTranscribe] Stream started successfully');
      this.isConnected = true;
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
      this.isConnected = false;
      log(`[AWSTranscribe] Connection error: ${error.message || error}`);
      const errorMessage = error.message || String(error);
      const isDeserializationError = errorMessage.toLowerCase().includes('deseriali') ||
                                     error.name === 'DeserializationError' ||
                                     error.__type === 'SerializationException';

      if (isDeserializationError) {
        log(`[AWSTranscribe] DESERIALIZATION ERROR - Invalid parameter format detected!`);
      }
      onError(error);
      log('[AWSTranscribe] Returning socket reference for audio buffering despite connection error');
      throw error;
    }
  }

  /* Create async generator for audio streaming */
  private createAudioStreamGenerator() {
    const audioChunks: Buffer[] = [];
    let resolveNext: any = null;
    // Store audio stream reference
    let chunkCount = 0;
    this.audioStream = {
      write: (chunk: Buffer) => {
        audioChunks.push(chunk);
        chunkCount++;
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
            break;
          }

          // Convert Buffer to Uint8Array for AWS SDK v3
          const uint8Array = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          yieldCount++;
          yield { AudioEvent: { AudioChunk: uint8Array } };
        }
        log(`[AWSTranscribe] Generator finished after ${yieldCount} chunks`);
      } catch (error: any) {
        log(`[AWSTranscribe] Generator error: ${error.message || error}`);
        throw error;
      }
    })();
  }

  /* Handle transcription result stream from AWS */
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

                // Extract AWS speaker label from Items
                let awsSpeakerLabel = null;
                if (result.Alternatives[0].Items && result.Alternatives[0].Items.length > 0) {
                  const speakerCounts: { [key: string]: number } = {};
                  result.Alternatives[0].Items.forEach((item: any) => {
                    if (item.Speaker) {
                      speakerCounts[item.Speaker] = (speakerCounts[item.Speaker] || 0) + 1;
                    }
                  });
                  const speakers = Object.keys(speakerCounts);
                  if (speakers.length > 0) {
                    awsSpeakerLabel = speakers.reduce((a, b) =>
                      speakerCounts[a] > speakerCounts[b] ? a : b
                    );
                  }
                }

                // Correlate AWS speaker label with real participant names. Use real name if available, otherwise fall back to AWS label
                // AWS returns timestamps in seconds, convert to milliseconds for correlation
                const startMs = (result.StartTime || 0) * 1000;
                const endMs = (result.EndTime || 0) * 1000;
                const realSpeaker = this.findSpeakerAtTime(startMs, endMs);
                const speaker = realSpeaker || awsSpeakerLabel;
                const language = result.LanguageCode || this.config.languageCode || 'en-US';
                log(`[AWSTranscribe] Speaker: ${speaker || 'unknown'} (AWS: ${awsSpeakerLabel || 'none'}), Language: ${language}`);
                // Format in WhisperLive-compatible format for unified callback
                const formattedData = {
                  type: 'transcription',
                  provider: 'aws',
                  segments: [
                    {
                      text: transcript,
                      start: result.StartTime || 0,
                      end: result.EndTime || 0,
                      speaker: speaker,
                      language: language,
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

  /* Send audio data to AWS Transcribe */
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

  /* Close AWS Transcribe connection */
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

  /* Get provider name */
  getProvider(): string {
    return 'aws';
  }

  /* Send speaker event for correlation with AWS transcription. 
  This allows mapping AWS's generic speaker labels (spk_0, spk_1) to real participant names
   */
  sendSpeakerEvent(
    eventType: string,
    participantName: string,
    participantId: string,
    relativeTimestampMs: number,
    botConfig: BotConfig
  ): boolean {
    this.speakerEvents.push({
      timestamp: relativeTimestampMs,
      eventType,
      participantName,
      participantId,
    });
    log(`[AWSTranscribe] Speaker event: ${eventType} - ${participantName} at ${relativeTimestampMs}ms`);
    if (this.speakerEvents.length > 1000) {
      this.speakerEvents.shift();
    }
    return true;
  }

  /* Correlates AWS speaker labels with actual participant names based on timing */
  private findSpeakerAtTime(startMs: number, endMs: number): string | null {
    if (this.speakerEvents.length === 0) {
      return null;
    }
    let currentSpeaker: string | null = null;
    let bestMatchTime = -1;

    for (const event of this.speakerEvents) {
      const timeDiff = event.timestamp - startMs;
      if (timeDiff <= 500 && timeDiff >= -500) {
        if (event.eventType === 'SPEAKER_START') {
          // Found a speaker who started around this time
          if (event.timestamp > bestMatchTime) {
            currentSpeaker = event.participantName;
            bestMatchTime = event.timestamp;
          }
        }
      } else if (event.timestamp < startMs - 500) {
        // Process historical events to find who was speaking
        if (event.eventType === 'SPEAKER_START') {
          currentSpeaker = event.participantName;
          bestMatchTime = event.timestamp;
        } else if (event.eventType === 'SPEAKER_END' && event.participantName === currentSpeaker) {
          // Speaker stopped before this segment
          currentSpeaker = null;
          bestMatchTime = -1;
        }
      }
    }

    if (currentSpeaker) {
      log(`[AWSTranscribe] Correlation: Segment at ${startMs}-${endMs}ms matched to ${currentSpeaker}`);
    }
    return currentSpeaker;
  }
}
