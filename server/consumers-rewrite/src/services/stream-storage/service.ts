/**
 * StreamStorage service definition
 */
import { Context, Effect, Schema, Stream } from "effect";

import { Event, Offset, StreamPath } from "../../domain.js";

// -------------------------------------------------------------------------------------
// Type ID (for nominal uniqueness)
// -------------------------------------------------------------------------------------

export const StreamStorageManagerTypeId: unique symbol = Symbol.for("@app/StreamStorageManager");
export type StreamStorageManagerTypeId = typeof StreamStorageManagerTypeId;

// -------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------

export class StreamStorageError extends Schema.TaggedError<StreamStorageError>()(
  "StreamStorageError",
  {
    cause: Schema.Defect,
    context: Schema.optionalWith(Schema.Unknown, { default: () => undefined }),
  },
) {}

// -------------------------------------------------------------------------------------
// StreamStorage (path-scoped data type)
// -------------------------------------------------------------------------------------

/**
 * A path-scoped storage interface - the path is already applied.
 */
export interface StreamStorage {
  /** Read events from this stream */
  readonly read: (options?: { from?: Offset; to?: Offset }) => Stream.Stream<Event>;

  /** Append an event to this stream (already has offset/createdAt assigned) */
  readonly append: (event: Event) => Effect.Effect<Event>;
}

// -------------------------------------------------------------------------------------
// StreamStorageManager (service with path in calls)
// -------------------------------------------------------------------------------------

/**
 * Storage manager service - manages storage across all paths.
 */
export interface StreamStorageManager {
  readonly [StreamStorageManagerTypeId]: StreamStorageManagerTypeId;

  /** List all existing stream paths */
  readonly listPaths: () => Effect.Effect<StreamPath[], StreamStorageError>;

  /** Get a path-scoped StreamStorage */
  readonly forPath: (path: StreamPath) => StreamStorage;

  /**
   * Read events from stream.
   * @param from - Exclusive start offset. Returns events with offset > from.
   * @param to - Inclusive end offset. Returns events with offset <= to.
   */
  readonly read: (input: {
    path: StreamPath;
    from?: Offset;
    to?: Offset;
  }) => Stream.Stream<Event, StreamStorageError>;

  /** Append event to stream (path is taken from event.path) */
  readonly append: (event: Event) => Effect.Effect<Event, StreamStorageError>;
}

export const StreamStorageManager = Context.GenericTag<StreamStorageManager>(
  "@app/StreamStorageManager",
);
