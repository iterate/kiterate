import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { FetchHttpClient } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";

import { OpenAiSimpleConsumerLayer } from "./consumers/openai-simple.js";
import { ServerLive } from "./server.js";
import { AiClient } from "./services/ai-client/index.js";
import { GrokVoiceClient, GrokVoiceConfig } from "./services/grok-voice/index.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

const StreamStorageLive = StreamStorage.fileSystemLayer(".data/streams").pipe(
  Layer.provide(NodeContext.layer),
);

// OpenAI client from OPENAI_API_KEY env var
const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// Language model using gpt-4o
const LanguageModelLive = OpenAiLanguageModel.layer({ model: "gpt-4o" }).pipe(
  Layer.provide(OpenAiClientLive),
);

// AiClient with OpenAI (Grok disabled - requires XAI_API_KEY)
const AiClientLive = AiClient.layer.pipe(
  Layer.provide(LanguageModelLive),
  Layer.provide(GrokVoiceClient.Default),
  Layer.provide(Layer.succeed(GrokVoiceConfig, { apiKey: "" })), // Dummy - Grok won't work without real key
);

// Consumers (background processes that run with the server)
const ConsumersLive = Layer.mergeAll(OpenAiSimpleConsumerLayer);

// StreamManager with consumers on top
const StreamManagerLive = ConsumersLive.pipe(
  Layer.provideMerge(StreamManager.liveLayer),
  Layer.provide(StreamStorageLive),
  Layer.provide(AiClientLive),
);

const MainLive = ServerLive(port).pipe(Layer.provide(StreamManagerLive));

NodeRuntime.runMain(Layer.launch(MainLive));
