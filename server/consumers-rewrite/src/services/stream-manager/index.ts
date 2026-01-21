/**
 * StreamManager - Event streaming with replay support
 */

// Re-export service definition
export { StreamManager } from "./service.js";

// Re-export EventStream namespace
export * as EventStream from "./eventStream.js";

// Re-export layers
export { liveLayer } from "./live.js";
export { agentLayer, testLayer as agentTestLayer } from "./agent.js";
