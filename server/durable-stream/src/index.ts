/**
 * @kiterate/durable-stream
 *
 * Effect-native event streaming infrastructure
 */

// Core stream management
export {
  Event,
  StreamPath,
  Offset,
  Payload,
  StreamStorageService,
  DurableStreamManager,
  InMemoryDurableStreamManager,
} from "./DurableStreamManager.js";

export type { DurableIterateStream, StreamStorage } from "./DurableStreamManager.js";

// HTTP server
export { AppLive, ServerLive } from "./server.js";

// Client
export {
  StreamClient,
  layer as StreamClientLayer,
  make as makeStreamClient,
} from "./StreamClient.js";
export type { StreamClientConfig } from "./StreamClient.js";

// SSE utilities
export * as Sse from "./Sse.js";
