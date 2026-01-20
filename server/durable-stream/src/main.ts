import { Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { InMemoryDurableStreamManager } from "./DurableStreamManager.js";
import { ServerLive } from "./server.js";

const port = parseInt(process.env.PORT ?? "3000", 10);

const MainLive = ServerLive(port).pipe(Layer.provide(InMemoryDurableStreamManager));

NodeRuntime.runMain(Layer.launch(MainLive));
