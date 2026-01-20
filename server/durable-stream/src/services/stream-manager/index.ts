/**
 * StreamManager - Event streaming with replay support
 */

// Re-export service definition
export { StreamManager } from "./service.js";

// Re-export IterateStream namespace
export * as IterateStream from "./iterateStream.js";

// Note: Import liveLayer directly from "./live.js" to avoid circular imports
