/**
 * StreamStorage - pluggable storage backend for durable streams
 */

// Re-export service definition
export type { StreamStorage } from "./service.js";
export { StreamStorageManager, StreamStorageError, StreamStorageManagerTypeId } from "./service.js";
export type { StreamStorageManagerTypeId as StreamStorageManagerTypeIdType } from "./service.js";

// Re-export layers
export { inMemoryLayer } from "./inMemory.js";
export { fileSystemLayer } from "./fileSystem.js";
