/**
 * Prompt Injection Detector Processor
 *
 * Monitors LLM requests for potential prompt injection attacks by running
 * a parallel detection check. If injection is detected (or check is still pending),
 * the RequestEndedEvent is intercepted to prevent codemode from executing.
 */
export * from "./events.js";
export * from "./processor.js";
export * from "./detectionModel.js";
