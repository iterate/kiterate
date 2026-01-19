/**
 * Voice PE Server - Main Entry Point
 *
 * Composes all layers and launches the server.
 *
 * Environment variables:
 * - PORT: HTTP server port (default: 3100)
 * - VOICE_PE_HOST: Voice PE device hostname/IP (required)
 * - VOICE_PE_PORT: Voice PE device API port (default: 6053)
 * - VOICE_PE_PSK: Base64-encoded pre-shared key for encryption (optional)
 */

import { Layer, Effect, Console } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { ServerLive } from "./server.js";
import { VoiceManagerLive } from "./VoiceManager.js";
import { VoiceConnectionLive, DeviceConfig } from "./VoiceConnection.js";
import { EchoPipelineLive } from "./VoicePipeline.js";

// Parse environment configuration
const port = parseInt(process.env.PORT ?? "3100", 10);
const voicePeHost = process.env.VOICE_PE_HOST;
const voicePePort = parseInt(process.env.VOICE_PE_PORT ?? "6053", 10);
const psk = process.env.VOICE_PE_PSK;

if (!voicePeHost) {
  console.log(`
Voice PE Server
===============

Usage:
  VOICE_PE_HOST=<device-ip> npm start

Environment variables:
  VOICE_PE_HOST          Voice PE device hostname or IP address (required)
  VOICE_PE_PORT          Voice PE device API port (default: 6053)
  VOICE_PE_PSK           Base64-encoded Noise pre-shared key (optional)
  PORT                   HTTP server port (default: 3100)

API Endpoints:
  GET  /health    Health check
  GET  /status    Current session and device status
  POST /start     Start listening for voice commands
  POST /stop      Stop listening
  POST /announce  Send text announcement to device
  GET  /events    SSE stream of voice events

Example:
  VOICE_PE_HOST=192.168.1.100 npm start
  curl http://localhost:3100/status
  curl -X POST http://localhost:3100/start
  curl -N http://localhost:3100/events
`);
  process.exit(1);
}

const deviceConfig: DeviceConfig = {
  host: voicePeHost,
  port: voicePePort,
  psk,
  clientId: "voice-pe-server",
};

console.log(`Connecting to Voice PE at ${voicePeHost}:${voicePePort}...`);

// Compose layers
// Note: Using EchoPipelineLive for now - replace with real STT/TTS implementations
const MainLive = ServerLive(port).pipe(
  Layer.provideMerge(VoiceManagerLive),
  Layer.provideMerge(EchoPipelineLive),
  Layer.provideMerge(VoiceConnectionLive(deviceConfig))
);

// Launch
NodeRuntime.runMain(
  Layer.launch(MainLive).pipe(
    Effect.tapErrorCause((cause) =>
      Console.error("Failed to start server:", cause)
    )
  )
);
