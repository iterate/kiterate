/**
 * AgentManager - orchestrates agents with LLM capabilities
 */

// Re-export service definition
export { AgentManager, AgentManagerError } from "./service.js";

// Re-export layers
export { liveLayer, testLayer } from "./live.js";
