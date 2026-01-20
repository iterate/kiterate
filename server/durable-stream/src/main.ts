import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";

import { ServerLive } from "./server.js";
import { GrokVoiceClient } from "./services/grok-voice/index.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

const StreamStorageLive = StreamStorage.fileSystemLayer(".data/streams").pipe(
  Layer.provide(NodeContext.layer),
);

// StreamManager with Grok voice layer on top of live layer
const StreamManagerLive = StreamManager.grokLayer.pipe(
  Layer.provide(StreamManager.liveLayer),
  Layer.provide(StreamStorageLive),
  Layer.provide(GrokVoiceClient.Default),
);

const MainLive = ServerLive(port).pipe(Layer.provide(StreamManagerLive));

NodeRuntime.runMain(Layer.launch(MainLive));
