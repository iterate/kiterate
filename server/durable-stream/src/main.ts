import { Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { ServerLive } from "./server.js"
import { InMemoryStreamManager } from "./StreamManager.js"

const port = parseInt(process.env.PORT ?? "3000", 10)

const MainLive = ServerLive(port).pipe(
  Layer.provide(InMemoryStreamManager)
)

NodeRuntime.runMain(Layer.launch(MainLive))
