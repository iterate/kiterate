/**
 * StreamClient - Effect service for consuming durable streams
 */

// Re-export service definition
export type { StreamClientConfig } from "./service.js";
export { StreamClient, StreamClientError } from "./service.js";

// Re-export layer
export { liveLayer } from "./live.js";
