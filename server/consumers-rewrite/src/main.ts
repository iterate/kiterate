import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as Otlp from "@effect/opentelemetry/Otlp";
import * as OtlpSerialization from "@effect/opentelemetry/OtlpSerialization";
import { FetchHttpClient } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";

import { CodemodeProcessorLayer } from "./processors/codemode/index.js";
import { LlmLoopProcessorLayer } from "./processors/llm-loop/index.js";
import { ServerLive } from "./server.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

// -------------------------------------------------------------------------------------
// Storage Backend Configuration
// -------------------------------------------------------------------------------------
// Choose ONE of these storage backends:
//
// SQLite (default) - persists to a single .db file, good for production
// const StorageLive = StreamStorage.sqliteLayer(".data/streams.db");
//
// File System - persists as YAML files in .data/streams/, human-readable
// const StorageLive = StreamStorage.fileSystemLayer;
//
// In-Memory - no persistence, good for testing
// const StorageLive = StreamStorage.inMemoryLayer;
// -------------------------------------------------------------------------------------
const StorageLive = StreamStorage.sqliteLayer(".data/streams.db");

// Jaeger tracing (local OTLP endpoint for debugging)
const TracingLive = Otlp.layer({
  baseUrl: "http://localhost:4318",
  resource: { serviceName: "kiterate" },
}).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(OtlpSerialization.layerJson));

// OpenAI client from OPENAI_API_KEY env var
const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// Language model using gpt-5.2-codex with low reasoning effort
const LanguageModelLive = OpenAiLanguageModel.layer({
  model: "gpt-5.2-codex",
  config: { reasoning: { effort: "low" } },
}).pipe(Layer.provide(OpenAiClientLive));

// Processors (background processes that run with the server)
const ProcessorsLive = Layer.mergeAll(LlmLoopProcessorLayer, CodemodeProcessorLayer);

// StreamManager with processors on top
const ManagerWithProcessors = ProcessorsLive.pipe(
  Layer.provideMerge(StreamManager.liveLayer),
  Layer.provide(StorageLive),
  Layer.provide(LanguageModelLive),
);

// Tracing is optional - only enable if ENABLE_TRACING=true (requires Jaeger at localhost:4318)
const enableTracing = process.env.ENABLE_TRACING === "true";

const ServerWithManager = ServerLive(port).pipe(Layer.provide(ManagerWithProcessors));

const MainLive = enableTracing
  ? ServerWithManager.pipe(Layer.provide(TracingLive))
  : ServerWithManager;

NodeRuntime.runMain(Layer.launch(MainLive));
