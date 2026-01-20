/**
 * Voice CLI for Grok interaction
 *
 * Converts typed text to speech, sends to Grok, and plays back the response.
 *
 * Usage:
 *   doppler run -- bun scripts/grok-voice-cli.ts [stream-path] [input-text]
 *
 * Interactive mode (no input-text):
 *   doppler run -- bun scripts/grok-voice-cli.ts demo
 *
 * Non-interactive mode (for testing):
 *   doppler run -- bun scripts/grok-voice-cli.ts demo "hello there"
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as readline from "node:readline";

import { HttpClient } from "@effect/platform";
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";

import { EventInput, EventType, StreamPath, type Event } from "../src/domain.js";
import {
  StreamClient,
  liveLayer as streamClientLiveLayer,
} from "../src/services/stream-client/index.js";

const BASE_URL = "http://localhost:3001";

/** Convert text to PCM audio using macOS say + ffmpeg */
const textToAudio = (text: string): Buffer => {
  const escaped = text.replace(/"/g, '\\"').replace(/'/g, "'\\''");
  execSync(`say -o /tmp/input.aiff "${escaped}"`);
  execSync(`ffmpeg -y -i /tmp/input.aiff -f s16le -ar 48000 -ac 1 /tmp/input.pcm 2>/dev/null`);
  return readFileSync("/tmp/input.pcm");
};

/** Play PCM audio chunks */
const playAudio = (chunks: string[]) => {
  if (chunks.length === 0) {
    console.log("(no audio in response)");
    return;
  }
  const pcm = Buffer.concat(chunks.map((c) => Buffer.from(c, "base64")));
  writeFileSync("/tmp/response.pcm", pcm);
  execSync(`ffmpeg -y -f s16le -ar 48000 -ac 1 -i /tmp/response.pcm /tmp/response.wav 2>/dev/null`);
  execSync(`afplay /tmp/response.wav`, { stdio: "inherit" });
};

/** Collect audio response from stream events */
const collectResponse = (
  events: Stream.Stream<Event>,
): Effect.Effect<{ audioChunks: string[]; transcript: string }> =>
  Effect.gen(function* () {
    const audioChunks: string[] = [];
    let transcript = "";

    yield* events.pipe(
      Stream.tap((evt) => {
        console.log(`[DEBUG] event type=${evt.type}`);
        return Effect.void;
      }),
      // Only look at grok:event events
      Stream.filter((evt) => evt.type === "grok:event"),
      Stream.tap((evt) => {
        const payload = evt.payload as { type?: string; delta?: string };
        console.log(`[DEBUG] grok:event payload.type=${payload?.type}`);
        if (payload?.type === "response.output_audio.delta" && payload.delta) {
          audioChunks.push(payload.delta);
        }
        if (payload?.type === "response.output_audio_transcript.delta" && payload.delta) {
          process.stdout.write(payload.delta);
          transcript += payload.delta;
        }
        return Effect.void;
      }),
      Stream.takeUntil((evt) => {
        const payload = evt.payload as { type?: string };
        return payload?.type === "response.done";
      }),
      Stream.runDrain,
    );

    return { audioChunks, transcript };
  });

/** Get the latest offset from the stream */
const getLatestOffset = (client: StreamClient["Type"], path: StreamPath) =>
  client.subscribe({ path, live: false }).pipe(
    Stream.runLast,
    Effect.map((lastEvent) => lastEvent?.offset),
  );

/** Process a single text input: convert to audio, send, collect response, play */
const processInput = (client: StreamClient["Type"], streamPath: StreamPath, text: string) =>
  Effect.gen(function* () {
    // Convert text to audio
    console.log(`[${new Date().toISOString()}] Converting text to audio...`);
    const audio = textToAudio(text);
    console.log(`[${new Date().toISOString()}] Sending ${audio.length} bytes of audio...`);

    // Get current offset so we only see NEW events
    const currentOffset = yield* getLatestOffset(client, streamPath);
    console.log(`[${new Date().toISOString()}] Current offset: ${currentOffset ?? "none"}`);

    // Send audio to stream
    console.log(`[${new Date().toISOString()}] Calling append...`);
    yield* client.append({
      path: streamPath,
      event: EventInput.make({
        type: EventType.make("grok:input:audio"),
        payload: { audio: audio.toString("base64") },
      }),
    });
    console.log(`[${new Date().toISOString()}] Append complete`);

    // Subscribe for NEW events only (after current offset)
    console.log(`[${new Date().toISOString()}] Subscribing for response...`);
    const responseStream = client.subscribe({
      path: streamPath,
      after: currentOffset,
      live: true,
    });

    // Collect response
    const { audioChunks } = yield* collectResponse(responseStream);
    console.log(
      `\n[${new Date().toISOString()}] Response complete, ${audioChunks.length} audio chunks`,
    );

    // Play response audio
    playAudio(audioChunks);
  });

const main = Effect.gen(function* () {
  const streamPath = StreamPath.make(process.argv[2] ?? "demo");
  const inputText = process.argv[3]; // Optional: non-interactive input
  const client = yield* StreamClient;

  console.log(`Grok Voice CLI - stream: ${streamPath}`);

  // Non-interactive mode: process single input and exit
  if (inputText) {
    console.log(`Non-interactive mode: "${inputText}"\n`);
    yield* processInput(client, streamPath, inputText);
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log('Type text to speak, or "quit" to exit.\n');

  while (true) {
    const text = yield* Effect.promise(() => question("> "));

    if (text === "quit" || text === "exit") {
      console.log("Goodbye!");
      rl.close();
      break;
    }

    if (!text.trim()) continue;

    yield* processInput(client, streamPath, text);
    console.log();
  }
});

// Layer setup - streamClientLiveLayer depends on HttpClient
const MainLayer = streamClientLiveLayer({ baseUrl: BASE_URL }).pipe(
  Layer.provide(NodeHttpClient.layer),
);

NodeRuntime.runMain(
  main.pipe(
    Effect.provide(MainLayer),
    Effect.catchAllCause((cause) => Effect.logError("CLI error", cause)),
  ),
);
