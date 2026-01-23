/**
 * SQLite implementation of StreamStorageManager
 *
 * Stores events in a SQLite database with a single `events` table.
 * Each row represents one event, with path + offset as the composite primary key.
 */
import { Reactivity } from "@effect/experimental";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { DateTime, Effect, Layer, Option, Stream } from "effect";

import { Event, EventType, Offset, Payload, StreamPath, Version } from "../../domain.js";
import { SpanId, TraceContext, TraceId } from "../../tracing/traceContext.js";
import {
  StreamStorage,
  StreamStorageError,
  StreamStorageManager,
  StreamStorageManagerTypeId,
} from "./service.js";

// -------------------------------------------------------------------------------------
// Row types (exported for tooling)
// -------------------------------------------------------------------------------------

/**
 * Raw database row shape for events table.
 * Exported for use by debug/CLI tools that need direct DB access.
 */
export interface EventRow {
  path: string;
  offset: string;
  type: string;
  payload: string;
  version: string;
  created_at: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
}

// -------------------------------------------------------------------------------------
// Row conversion
// -------------------------------------------------------------------------------------

const eventToRow = (event: Event): EventRow => ({
  path: event.path,
  offset: event.offset,
  type: event.type,
  payload: JSON.stringify(event.payload),
  version: event.version,
  created_at: DateTime.formatIso(event.createdAt),
  trace_id: event.trace.traceId,
  span_id: event.trace.spanId,
  parent_span_id: Option.getOrNull(event.trace.parentSpanId),
});

const rowToEvent = (row: EventRow): Event =>
  Event.make({
    path: StreamPath.make(row.path),
    offset: Offset.make(row.offset),
    type: EventType.make(row.type),
    payload: JSON.parse(row.payload) as Payload,
    version: Version.make(row.version),
    createdAt: DateTime.unsafeFromDate(new Date(row.created_at)),
    trace: TraceContext.make({
      traceId: TraceId.make(row.trace_id),
      spanId: SpanId.make(row.span_id),
      parentSpanId: row.parent_span_id
        ? Option.some(SpanId.make(row.parent_span_id))
        : Option.none(),
    }),
  });

// -------------------------------------------------------------------------------------
// Layer factory
// -------------------------------------------------------------------------------------

/**
 * Create a SQLite-backed StreamStorageManager layer.
 *
 * @param filename - Path to the SQLite database file (e.g., `.data/streams.db`)
 */
export const sqliteLayer = (
  filename: string,
): Layer.Layer<StreamStorageManager, StreamStorageError> =>
  Layer.scoped(
    StreamStorageManager,
    Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;

      // Initialize schema
      yield* sql`
        CREATE TABLE IF NOT EXISTS events (
          path TEXT NOT NULL,
          offset TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          version TEXT NOT NULL DEFAULT '1',
          created_at TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          parent_span_id TEXT,
          PRIMARY KEY (path, offset)
        )
      `;

      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_events_path_offset ON events(path, offset)
      `;

      const append = (event: Event) =>
        Effect.gen(function* () {
          const row = eventToRow(event);
          yield* sql`
            INSERT INTO events (path, offset, type, payload, version, created_at, trace_id, span_id, parent_span_id)
            VALUES (${row.path}, ${row.offset}, ${row.type}, ${row.payload}, ${row.version}, ${row.created_at}, ${row.trace_id}, ${row.span_id}, ${row.parent_span_id})
          `;
          return event;
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause, context: { event } })));

      const read = ({ path, from, to }: { path: StreamPath; from?: Offset; to?: Offset }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Build query based on provided bounds
            let rows: readonly EventRow[];

            if (from !== undefined && to !== undefined) {
              rows = yield* sql<EventRow>`
                SELECT * FROM events
                WHERE path = ${path} AND offset > ${from} AND offset <= ${to}
                ORDER BY offset ASC
              `;
            } else if (from !== undefined) {
              rows = yield* sql<EventRow>`
                SELECT * FROM events
                WHERE path = ${path} AND offset > ${from}
                ORDER BY offset ASC
              `;
            } else if (to !== undefined) {
              rows = yield* sql<EventRow>`
                SELECT * FROM events
                WHERE path = ${path} AND offset <= ${to}
                ORDER BY offset ASC
              `;
            } else {
              rows = yield* sql<EventRow>`
                SELECT * FROM events
                WHERE path = ${path}
                ORDER BY offset ASC
              `;
            }

            const events = rows.map(rowToEvent);
            return Stream.fromIterable(events);
          }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
        );

      const forPath = (streamPath: StreamPath): StreamStorage => ({
        read: (options) =>
          read({
            path: streamPath,
            ...(options?.from !== undefined && { from: options.from }),
            ...(options?.to !== undefined && { to: options.to }),
          }).pipe(Stream.catchAllCause(() => Stream.empty)),
        append: (event) => append(event).pipe(Effect.orDie),
      });

      return StreamStorageManager.of({
        [StreamStorageManagerTypeId]: StreamStorageManagerTypeId,
        listPaths: () =>
          Effect.gen(function* () {
            const rows = yield* sql<{ path: string }>`
              SELECT DISTINCT path FROM events ORDER BY path ASC
            `;
            return rows.map((row) => StreamPath.make(row.path));
          }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
        forPath,
        append,
        read,
      });
    }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
  ).pipe(
    Layer.provide(SqliteClient.layer({ filename }).pipe(Layer.provide(Reactivity.layer))),
    Layer.mapError((cause) => StreamStorageError.make({ cause })),
  );
