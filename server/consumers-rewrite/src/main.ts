import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as Otlp from "@effect/opentelemetry/Otlp";
import * as OtlpSerialization from "@effect/opentelemetry/OtlpSerialization";
import { FetchHttpClient } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";

import { CodemodeProcessorLayer, toolRegistryEmptyLayer } from "./processors/codemode/index.js";
import { LlmLoopProcessorLayer } from "./processors/llm-loop/index.js";
import { ServerLive } from "./server.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

// Jaeger tracing (local OTLP endpoint for debugging)
const TracingLive = Otlp.layer({
  baseUrl: "http://localhost:4318",
  resource: { serviceName: "kiterate" },
}).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(OtlpSerialization.layerJson));

const StreamStorageLive = StreamStorage.fileSystemLayer(".data/streams").pipe(
  Layer.provide(NodeContext.layer),
);

// OpenAI client from OPENAI_API_KEY env var
const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// Language model using gpt-5.2-codex with low reasoning effort
const LanguageModelLive = OpenAiLanguageModel.layer({
  model: "gpt-5.2-codex",
  config: {
    reasoning: {
      effort: "low",
    },
  },
}).pipe(Layer.provide(OpenAiClientLive));

// Empty tool registry (tools will be registered via events)
const ToolRegistryLive = toolRegistryEmptyLayer;

// Processors (background processes that run with the server)
const ProcessorsLive = Layer.mergeAll(LlmLoopProcessorLayer, CodemodeProcessorLayer);

// StreamManager with processors on top
const StreamManagerLive = ProcessorsLive.pipe(
  Layer.provideMerge(StreamManager.liveLayer),
  Layer.provide(StreamStorageLive),
  Layer.provide(LanguageModelLive),
  Layer.provide(ToolRegistryLive),
);

const MainLive = ServerLive(port).pipe(
  Layer.provide(StreamManagerLive),
  Layer.provide(TracingLive),
);

NodeRuntime.runMain(Layer.launch(MainLive));
