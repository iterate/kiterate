/**
 * VoicePipeline - Voice processing pipeline services
 *
 * Defines interfaces for STT, Intent Processing, and TTS services.
 * Provides a pluggable architecture for voice command processing.
 */

import { Effect, Context, Layer, Stream, Data, Schema } from "effect";

// -------------------------------------------------------------------------------------
// Data types
// -------------------------------------------------------------------------------------

export class VoicePipelineError extends Data.TaggedError("VoicePipelineError")<{
  readonly stage: "stt" | "intent" | "tts";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const TranscriptionResult = Schema.Struct({
  text: Schema.String,
  confidence: Schema.optional(Schema.Number),
  language: Schema.optional(Schema.String),
});
export type TranscriptionResult = typeof TranscriptionResult.Type;

export const IntentResult = Schema.Struct({
  intent: Schema.String,
  slots: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  responseText: Schema.String,
  conversationId: Schema.optional(Schema.String),
});
export type IntentResult = typeof IntentResult.Type;

export const AudioFormat = Schema.Struct({
  sampleRate: Schema.Number,
  bitDepth: Schema.Number,
  channels: Schema.Number,
});
export type AudioFormat = typeof AudioFormat.Type;

// Voice PE audio format: 16kHz, 16-bit, mono PCM
export const VOICE_PE_INPUT_FORMAT: AudioFormat = {
  sampleRate: 16000,
  bitDepth: 16,
  channels: 1,
};

// -------------------------------------------------------------------------------------
// SpeechToText service
// -------------------------------------------------------------------------------------

export interface SpeechToText {
  /** Transcribe audio stream to text */
  readonly transcribe: (
    audioStream: Stream.Stream<Buffer>,
    format: AudioFormat
  ) => Effect.Effect<TranscriptionResult, VoicePipelineError>;
}

export class SpeechToTextService extends Context.Tag("@voice-pe/SpeechToText")<
  SpeechToTextService,
  SpeechToText
>() {}

// -------------------------------------------------------------------------------------
// IntentProcessor service
// -------------------------------------------------------------------------------------

export interface IntentProcessor {
  /** Process transcribed text into an intent and response */
  readonly process: (
    text: string,
    conversationId?: string
  ) => Effect.Effect<IntentResult, VoicePipelineError>;
}

export class IntentProcessorService extends Context.Tag("@voice-pe/IntentProcessor")<
  IntentProcessorService,
  IntentProcessor
>() {}

// -------------------------------------------------------------------------------------
// TextToSpeech service
// -------------------------------------------------------------------------------------

export interface TextToSpeech {
  /** Convert text to audio stream */
  readonly synthesize: (
    text: string,
    outputFormat: AudioFormat
  ) => Stream.Stream<Buffer, VoicePipelineError>;
}

export class TextToSpeechService extends Context.Tag("@voice-pe/TextToSpeech")<
  TextToSpeechService,
  TextToSpeech
>() {}

// -------------------------------------------------------------------------------------
// VoicePipeline - orchestrates the full voice processing flow
// -------------------------------------------------------------------------------------

export interface VoicePipeline {
  /** Process a complete voice interaction */
  readonly processVoiceRequest: (
    audioStream: Stream.Stream<Buffer>,
    conversationId?: string
  ) => Effect.Effect<
    {
      transcription: TranscriptionResult;
      intent: IntentResult;
      responseAudio: Stream.Stream<Buffer, VoicePipelineError>;
    },
    VoicePipelineError
  >;
}

export class VoicePipelineService extends Context.Tag("@voice-pe/VoicePipeline")<
  VoicePipelineService,
  VoicePipeline
>() {}

// -------------------------------------------------------------------------------------
// VoicePipeline implementation
// -------------------------------------------------------------------------------------

export const VoicePipelineLive: Layer.Layer<
  VoicePipelineService,
  never,
  SpeechToTextService | IntentProcessorService | TextToSpeechService
> = Layer.effect(
  VoicePipelineService,
  Effect.gen(function* () {
    const stt = yield* SpeechToTextService;
    const intentProcessor = yield* IntentProcessorService;
    const tts = yield* TextToSpeechService;

    const processVoiceRequest: VoicePipeline["processVoiceRequest"] = (
      audioStream,
      conversationId
    ) =>
      Effect.gen(function* () {
        // Step 1: Speech to Text
        const transcription = yield* stt.transcribe(
          audioStream,
          VOICE_PE_INPUT_FORMAT
        );

        // Step 2: Intent Processing
        const intent = yield* intentProcessor.process(
          transcription.text,
          conversationId
        );

        // Step 3: Text to Speech (returns stream, doesn't block)
        const responseAudio = tts.synthesize(intent.responseText, {
          sampleRate: 22050, // Common TTS output rate
          bitDepth: 16,
          channels: 1,
        });

        return {
          transcription,
          intent,
          responseAudio,
        };
      });

    return { processVoiceRequest };
  })
);

// -------------------------------------------------------------------------------------
// Echo implementation (for testing)
// -------------------------------------------------------------------------------------

/** A simple echo STT that returns the audio length as text */
export const EchoSpeechToText: Layer.Layer<SpeechToTextService> = Layer.succeed(
  SpeechToTextService,
  {
    transcribe: (audioStream, _format) =>
      Effect.gen(function* () {
        let totalBytes = 0;
        yield* audioStream.pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              totalBytes += chunk.length;
            })
          )
        );
        return {
          text: `[Received ${totalBytes} bytes of audio]`,
          confidence: 1.0,
        };
      }),
  }
);

/** A simple echo intent processor that echoes back the input */
export const EchoIntentProcessor: Layer.Layer<IntentProcessorService> = Layer.succeed(
  IntentProcessorService,
  {
    process: (text, conversationId) =>
      Effect.succeed({
        intent: "echo",
        responseText: `You said: ${text}`,
        conversationId,
      }),
  }
);

/** A silent TTS that produces no audio (for testing) */
export const SilentTextToSpeech: Layer.Layer<TextToSpeechService> = Layer.succeed(
  TextToSpeechService,
  {
    synthesize: (_text, _format) => Stream.empty,
  }
);

/** Combined echo pipeline for testing */
export const EchoPipelineLive: Layer.Layer<VoicePipelineService> = VoicePipelineLive.pipe(
  Layer.provide(EchoSpeechToText),
  Layer.provide(EchoIntentProcessor),
  Layer.provide(SilentTextToSpeech)
);

// -------------------------------------------------------------------------------------
// In-source tests
// -------------------------------------------------------------------------------------

if (import.meta.vitest) {
  const { it, expect, describe } = import.meta.vitest;

  describe("VoicePipeline", () => {
    it("EchoSpeechToText returns byte count", async () => {
      const program = Effect.gen(function* () {
        const stt = yield* SpeechToTextService;
        const audioData = Buffer.from("hello world test audio data");
        const audioStream = Stream.make(audioData);
        const result = yield* stt.transcribe(audioStream, VOICE_PE_INPUT_FORMAT);
        expect(result.text).toBe(`[Received ${audioData.length} bytes of audio]`);
        expect(result.confidence).toBe(1.0);
      }).pipe(Effect.provide(EchoSpeechToText));

      await Effect.runPromise(program);
    });

    it("EchoSpeechToText handles multiple chunks", async () => {
      const program = Effect.gen(function* () {
        const stt = yield* SpeechToTextService;
        const chunk1 = Buffer.from("chunk1");
        const chunk2 = Buffer.from("chunk2");
        const chunk3 = Buffer.from("chunk3");
        const audioStream = Stream.make(chunk1, chunk2, chunk3);
        const result = yield* stt.transcribe(audioStream, VOICE_PE_INPUT_FORMAT);
        const expectedBytes = chunk1.length + chunk2.length + chunk3.length;
        expect(result.text).toBe(`[Received ${expectedBytes} bytes of audio]`);
      }).pipe(Effect.provide(EchoSpeechToText));

      await Effect.runPromise(program);
    });

    it("EchoIntentProcessor echoes input text", async () => {
      const program = Effect.gen(function* () {
        const intent = yield* IntentProcessorService;
        const result = yield* intent.process("turn on the lights", "conv-123");
        expect(result.intent).toBe("echo");
        expect(result.responseText).toBe("You said: turn on the lights");
        expect(result.conversationId).toBe("conv-123");
      }).pipe(Effect.provide(EchoIntentProcessor));

      await Effect.runPromise(program);
    });

    it("SilentTextToSpeech produces empty stream", async () => {
      const program = Effect.gen(function* () {
        const tts = yield* TextToSpeechService;
        const audioStream = tts.synthesize("hello", { sampleRate: 22050, bitDepth: 16, channels: 1 });
        const chunks: Buffer[] = [];
        yield* audioStream.pipe(
          Stream.runForEach((chunk) => Effect.sync(() => chunks.push(chunk)))
        );
        expect(chunks).toHaveLength(0);
      }).pipe(Effect.provide(SilentTextToSpeech));

      await Effect.runPromise(program);
    });

    it("EchoPipeline processes complete voice request", async () => {
      const program = Effect.gen(function* () {
        const pipeline = yield* VoicePipelineService;
        const audioData = Buffer.alloc(1600); // 100ms of 16kHz audio
        const audioStream = Stream.make(audioData);
        const result = yield* pipeline.processVoiceRequest(audioStream, "test-conv");

        expect(result.transcription.text).toBe(`[Received ${audioData.length} bytes of audio]`);
        expect(result.intent.intent).toBe("echo");
        expect(result.intent.responseText).toContain("You said:");
      }).pipe(Effect.provide(EchoPipelineLive));

      await Effect.runPromise(program);
    });
  });

  describe("AudioFormat", () => {
    it("VOICE_PE_INPUT_FORMAT has correct values", () => {
      expect(VOICE_PE_INPUT_FORMAT.sampleRate).toBe(16000);
      expect(VOICE_PE_INPUT_FORMAT.bitDepth).toBe(16);
      expect(VOICE_PE_INPUT_FORMAT.channels).toBe(1);
    });
  });
}
