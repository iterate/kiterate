/**
 * StreamStorage - pluggable storage backend for durable streams
 */

// Re-export service definition
export { StreamStorage, StreamStorageError, StreamStorageTypeId } from "./service.js";
export type { StreamStorageTypeId as StreamStorageTypeIdType } from "./service.js";

// Re-export layers
export { inMemoryLayer } from "./inMemory.js";
export { fileSystemLayer } from "./fileSystem.js";
