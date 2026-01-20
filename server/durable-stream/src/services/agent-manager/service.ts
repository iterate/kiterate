/**
 * AgentManager service - orchestrates agents with LLM capabilities
 *
 * Wraps StreamManager to:
 * - Subscribe to agent event streams
 * - Validate and append events (may trigger LLM generation internally)
 */
import { Context, Effect, Schema, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorageError } from "../stream-storage/service.js";

// -------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------

export class AgentManagerError extends Schema.TaggedError<AgentManagerError>()(
  "AgentManagerError",
  {
    operation: Schema.Literal("subscribe", "append"),
    cause: Schema.Defect,
  },
) {}

// -------------------------------------------------------------------------------------
// Service definition
// -------------------------------------------------------------------------------------

export class AgentManager extends Context.Tag("@app/AgentManager")<
  AgentManager,
  {
    /**
     * Subscribe to an agent's event stream (delegates to StreamManager)
     */
    readonly subscribe: (input: {
      path: StreamPath;
      from?: Offset;
      live?: boolean;
    }) => Stream.Stream<Event, StreamStorageError>;

    /**
     * Append an event to the agent stream.
     * May trigger LLM generation based on payload (implementation detail).
     */
    readonly append: (input: {
      path: StreamPath;
      event: EventInput;
    }) => Effect.Effect<void, AgentManagerError | StreamStorageError>;
  }
>() {}
