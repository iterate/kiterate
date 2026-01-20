/**
 * Quick test script for Grok voice client
 * Run: doppler run -- bun scripts/test-grok.ts
 */
import { writeFileSync } from "node:fs";
import { Console, Effect, Stream } from "effect";
import { GrokVoiceClient } from "../src/services/grok-voice/index.js";

const program = Effect.gen(function* () {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    yield* Effect.die("XAI_API_KEY environment variable is required");
  }

  yield* Console.log("Connecting to Grok...");

  const voiceClient = yield* GrokVoiceClient;
  const connection = yield* voiceClient.connect({ apiKey });

  yield* Console.log("Waiting for ready...");
  yield* connection.waitForReady;

  yield* Console.log("Connected! Sending prompt...\n");

  // Send a text prompt
  yield* connection.sendText("Say hello and tell me a short joke.");

  // Collect audio and log events
  const audioChunks: Buffer[] = [];

  yield* connection.events
    .pipe(
      Stream.tap((evt) => {
        const e = evt as { type?: string; delta?: string };
        if (e.type === "response.output_audio.delta" && e.delta) {
          audioChunks.push(Buffer.from(e.delta, "base64"));
        } else if (e.type === "response.output_audio_transcript.delta" && e.delta) {
          process.stdout.write(e.delta);
        }
        return Effect.void;
      }),
      Stream.takeWhile((evt) => (evt as { type?: string }).type !== "response.done"),
      Stream.timeout("15 seconds"),
      Stream.runDrain,
    )
    .pipe(Effect.catchTag("TimeoutException", () => Effect.void));

  // Save audio
  const audioBuffer = Buffer.concat(audioChunks);
  if (audioBuffer.length > 0) {
    writeFileSync("/tmp/grok-output.pcm", audioBuffer);
    yield* Console.log(`\n\nAudio: /tmp/grok-output.pcm (${audioBuffer.length} bytes)`);
  }

  yield* connection.close;
}).pipe(Effect.provide(GrokVoiceClient.Default));

Effect.runPromise(program).catch(console.error);
