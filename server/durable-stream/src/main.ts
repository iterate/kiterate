import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { NodeHttpClient } from "@effect/platform-node";
import { NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";

import { ServerLive } from "./server.js";
import * as AgentManager from "./services/agent-manager/index.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

// OpenAI client configured via OPENAI_API_KEY env var
const OpenAiLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(NodeHttpClient.layerUndici));

// Language model using gpt-4o
const LanguageModelLive = OpenAiLanguageModel.model("gpt-4o").pipe(Layer.provide(OpenAiLive));

const MainLive = ServerLive(port).pipe(
  Layer.provide(AgentManager.liveLayer),
  Layer.provide(StreamManager.liveLayer),
  Layer.provide(StreamStorage.inMemoryLayer),
  Layer.provide(LanguageModelLive),
);

NodeRuntime.runMain(Layer.launch(MainLive));
