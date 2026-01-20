import { Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";

import { ServerLive } from "./server.js";
import * as AgentManager from "./services/agent-manager/index.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

const MainLive = ServerLive(port).pipe(
  Layer.provide(AgentManager.testLayer), // TODO: use liveLayer with LanguageModel for LLM support
  Layer.provide(StreamManager.liveLayer),
  Layer.provide(StreamStorage.inMemoryLayer),
);

NodeRuntime.runMain(Layer.launch(MainLive));
