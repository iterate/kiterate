/**
 * @kiterate/durable-stream
 *
 * Effect-native event streaming infrastructure
 */

// Domain types
export { Event, Offset, Payload, StreamPath } from "./domain.js";

// Services
export * as StreamStorage from "./services/stream-storage/index.js";
export * as StreamManager from "./services/stream-manager/index.js";

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
