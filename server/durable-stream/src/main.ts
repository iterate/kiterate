import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";

import { ServerLive } from "./server.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

// OpenAI client configured via OPENAI_API_KEY env var
const OpenAiLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(NodeHttpClient.layerUndici));

// Language model using gpt-4o
const LanguageModelLive = OpenAiLanguageModel.model("gpt-4o").pipe(Layer.provide(OpenAiLive));

const StreamStorageLive = StreamStorage.fileSystemLayer(".data/streams").pipe(
  Layer.provide(NodeContext.layer),
);

// StreamManager with agent layer (LLM integration) on top of live layer
const StreamManagerLive = StreamManager.agentLayer.pipe(
  Layer.provide(StreamManager.liveLayer),
  Layer.provide(StreamStorageLive),
  Layer.provide(LanguageModelLive),
);

const MainLive = ServerLive(port).pipe(Layer.provide(StreamManagerLive));

NodeRuntime.runMain(Layer.launch(MainLive));
