import { Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";

import { ServerLive } from "./server.js";
import { liveLayer as streamManagerLiveLayer } from "./services/stream-manager/live.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

const MainLive = ServerLive(port).pipe(
  Layer.provide(streamManagerLiveLayer),
  Layer.provide(StreamStorage.inMemoryLayer),
);

NodeRuntime.runMain(Layer.launch(MainLive));
