#!/usr/bin/env npx tsx
/**
 * Debug CLI for exploring event streams and testing interjection modes.
 *
 * Usage:
 *   tsx src/debug-cli.ts --help
 *   tsx src/debug-cli.ts events --last 20
 *   tsx src/debug-cli.ts chat "Hello" --mode queue
 *   tsx src/debug-cli.ts db paths
 */
import { Args, Command, Options } from "@effect/cli";
import { Reactivity } from "@effect/experimental";
import { FetchHttpClient } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import * as SqlError from "@effect/sql/SqlError";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Chunk, Console, Context, Duration, Effect, Layer, Option, Stream } from "effect";

import { StreamPath } from "./domain.js";
import { CancelRequestEvent, ConfigSetEvent, UserMessageEvent } from "./events.js";
import * as StreamClient from "./services/stream-client/index.js";
import type { EventRow } from "./services/stream-storage/index.js";

// -------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DB_FILE = ".data/streams.db";
const DEFAULT_PATH = process.env.STREAM_PATH ?? "test/modes";

// -------------------------------------------------------------------------------------
// SqliteReader Service (Effect-based read-only access)
// -------------------------------------------------------------------------------------

class SqliteReader extends Context.Tag("SqliteReader")<
  SqliteReader,
  {
    readonly listPaths: () => Effect.Effect<readonly string[], SqlError.SqlError>;
    readonly getEvents: (
      path: string,
      limit?: number,
    ) => Effect.Effect<readonly EventRow[], SqlError.SqlError>;
    readonly searchEvents: (
      pattern: string,
      path?: string,
    ) => Effect.Effect<readonly EventRow[], SqlError.SqlError>;
    readonly countEvents: (path?: string) => Effect.Effect<number, SqlError.SqlError>;
  }
>() {}

const SqliteReaderLive = Layer.effect(
  SqliteReader,
  Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;

    return SqliteReader.of({
      listPaths: () =>
        Effect.gen(function* () {
          const rows = yield* sql<{ path: string }>`
            SELECT DISTINCT path FROM events ORDER BY path
          `;
          return rows.map((r) => r.path);
        }),

      getEvents: (path, limit) =>
        Effect.gen(function* () {
          if (limit !== undefined) {
            return yield* sql<EventRow>`
              SELECT * FROM events WHERE path = ${path} ORDER BY offset ASC LIMIT ${limit}
            `;
          }
          return yield* sql<EventRow>`
            SELECT * FROM events WHERE path = ${path} ORDER BY offset ASC
          `;
        }),

      searchEvents: (pattern, path) =>
        Effect.gen(function* () {
          const likePattern = `%${pattern}%`;
          if (path) {
            return yield* sql<EventRow>`
              SELECT * FROM events
              WHERE path = ${path} AND (type LIKE ${likePattern} OR payload LIKE ${likePattern})
              ORDER BY offset ASC
            `;
          }
          return yield* sql<EventRow>`
            SELECT * FROM events
            WHERE type LIKE ${likePattern} OR payload LIKE ${likePattern}
            ORDER BY offset ASC
          `;
        }),

      countEvents: (path) =>
        Effect.gen(function* () {
          if (path) {
            const rows = yield* sql<{ count: number }>`
              SELECT COUNT(*) as count FROM events WHERE path = ${path}
            `;
            return rows[0]?.count ?? 0;
          }
          const rows = yield* sql<{ count: number }>`
            SELECT COUNT(*) as count FROM events
          `;
          return rows[0]?.count ?? 0;
        }),
    });
  }),
);

const ReaderLayer = SqliteReaderLive.pipe(
  Layer.provide(SqliteClient.layer({ filename: DB_FILE }).pipe(Layer.provide(Reactivity.layer))),
);

// -------------------------------------------------------------------------------------
// Display Helpers
// -------------------------------------------------------------------------------------

function shortType(type: string): string {
  return type.replace("iterate:", "").replace(":called", "").replace("llm-loop:", "");
}

function parsePayload(row: EventRow): Record<string, unknown> {
  return JSON.parse(row.payload) as Record<string, unknown>;
}

const displayConversation = (events: readonly EventRow[]) =>
  Effect.sync(() => {
    let currentAssistant = "";

    for (const ev of events) {
      const payload = parsePayload(ev);

      if (ev.type.includes("send-user-message")) {
        if (currentAssistant) {
          console.log(`\x1b[32mAssistant:\x1b[0m ${currentAssistant}`);
          currentAssistant = "";
        }
        const content = payload.content ?? "?";
        const mode = payload.mode ? ` [${payload.mode}]` : "";
        console.log(`\x1b[34mUser${mode}:\x1b[0m ${content}`);
      } else if (ev.type.includes("response:sse")) {
        const part = payload.part as Record<string, unknown> | undefined;
        if (part?.type === "text-delta" && part.delta) {
          currentAssistant += part.delta;
        }
      } else if (ev.type.includes("request-ended") || ev.type.includes("request-cancelled")) {
        if (currentAssistant) {
          const marker = ev.type.includes("cancelled") ? " \x1b[31m[interrupted]\x1b[0m" : "";
          console.log(`\x1b[32mAssistant:\x1b[0m ${currentAssistant}${marker}`);
          currentAssistant = "";
        }
      }
    }

    if (currentAssistant) {
      console.log(`\x1b[32mAssistant:\x1b[0m ${currentAssistant}`);
    }
  });

const displayRequests = (events: readonly EventRow[]) =>
  Effect.sync(() => {
    const requests: Map<string, { started?: string; ended?: string; status: string }> = new Map();

    for (const ev of events) {
      const payload = parsePayload(ev);

      if (ev.type.includes("request-started")) {
        requests.set(ev.offset, { started: ev.offset, status: "started" });
      } else if (ev.type.includes("request-ended")) {
        const reqOffset = payload.requestOffset as string | undefined;
        if (reqOffset && requests.has(reqOffset)) {
          requests.get(reqOffset)!.ended = ev.offset;
          requests.get(reqOffset)!.status = "completed";
        }
      } else if (ev.type.includes("request-cancelled")) {
        const reqOffset = payload.requestOffset as string | undefined;
        const reason = payload.reason ?? "unknown";
        if (reqOffset && requests.has(reqOffset)) {
          requests.get(reqOffset)!.ended = ev.offset;
          requests.get(reqOffset)!.status = `cancelled:${reason}`;
        }
      }
    }

    console.log("Request Lifecycle:");
    console.log("-".repeat(60));
    for (const [offset, info] of requests) {
      const statusColor = info.status === "completed" ? "\x1b[32m" : "\x1b[31m";
      console.log(`  ${offset} → ${info.ended ?? "..."} ${statusColor}${info.status}\x1b[0m`);
    }
  });

const displayEvents = (events: readonly EventRow[]) =>
  Effect.sync(() => {
    for (const ev of events) {
      const payload = parsePayload(ev);
      const part = payload.part as Record<string, unknown> | undefined;
      const delta = part?.delta ? ` δ="${part.delta}"` : "";
      const reason = payload.reason ? ` reason=${payload.reason}` : "";
      console.log(`[${ev.offset}] ${shortType(ev.type)}${delta}${reason}`);
    }
  });

// -------------------------------------------------------------------------------------
// Shared Options
// -------------------------------------------------------------------------------------

const pathOption = Options.text("path").pipe(
  Options.withAlias("p"),
  Options.withDescription("Stream path (e.g., chat/room1)"),
  Options.withDefault(DEFAULT_PATH),
);

const lastOption = Options.integer("last").pipe(
  Options.withAlias("n"),
  Options.withDescription("Number of events to show"),
  Options.withDefault(20),
);

const typeOption = Options.text("type").pipe(
  Options.withAlias("t"),
  Options.withDescription("Filter by event type"),
  Options.optional,
);

// -------------------------------------------------------------------------------------
// Query Commands (offline - SQLite)
// -------------------------------------------------------------------------------------

const eventsCommand = Command.make(
  "events",
  { path: pathOption, last: lastOption, type: typeOption },
  ({ path, last, type }) =>
    Effect.gen(function* () {
      const reader = yield* SqliteReader;
      let events = yield* reader.getEvents(path);

      if (events.length === 0) {
        yield* Console.log(`No events for path: ${path}`);
        return;
      }

      if (Option.isSome(type)) {
        events = events.filter((e) => e.type.includes(type.value));
      }
      events = events.slice(-last);

      yield* Console.log(`Events for ${path} (showing last ${events.length}):`);
      yield* displayEvents(events);
    }).pipe(
      Effect.provide(ReaderLayer),
      Effect.catchAll(() => Console.log(`No database at ${DB_FILE}`)),
    ),
).pipe(Command.withDescription("Show events with optional filters"));

const convoCommand = Command.make("convo", { path: pathOption }, ({ path }) =>
  Effect.gen(function* () {
    const reader = yield* SqliteReader;
    const events = yield* reader.getEvents(path);

    if (events.length === 0) {
      yield* Console.log(`No events for path: ${path}`);
      return;
    }

    yield* displayConversation(events);
  }).pipe(
    Effect.provide(ReaderLayer),
    Effect.catchAll(() => Console.log(`No database at ${DB_FILE}`)),
  ),
).pipe(Command.withDescription("Show conversation (user/assistant messages only)"));

const requestsCommand = Command.make("requests", { path: pathOption }, ({ path }) =>
  Effect.gen(function* () {
    const reader = yield* SqliteReader;
    const events = yield* reader.getEvents(path);

    if (events.length === 0) {
      yield* Console.log(`No events for path: ${path}`);
      return;
    }

    yield* displayRequests(events);
  }).pipe(
    Effect.provide(ReaderLayer),
    Effect.catchAll(() => Console.log(`No database at ${DB_FILE}`)),
  ),
).pipe(Command.withDescription("Show request lifecycle (started → ended/cancelled)"));

const patternArg = Args.text({ name: "pattern" }).pipe(Args.withDescription("Search pattern"));

const searchCommand = Command.make(
  "search",
  { pattern: patternArg, path: pathOption },
  ({ pattern, path }) =>
    Effect.gen(function* () {
      const reader = yield* SqliteReader;
      const events = yield* reader.searchEvents(pattern, path);

      yield* Console.log(`Found ${events.length} events matching "${pattern}":`);
      for (const ev of events.slice(-10)) {
        yield* Console.log(`  [${ev.offset}] ${shortType(ev.type)}`);
      }
    }).pipe(
      Effect.provide(ReaderLayer),
      Effect.catchAll(() => Console.log(`No database at ${DB_FILE}`)),
    ),
).pipe(Command.withDescription("Search events by pattern"));

// -------------------------------------------------------------------------------------
// DB Commands (SQLite-specific)
// -------------------------------------------------------------------------------------

const dbPathsCommand = Command.make("paths", {}, () =>
  Effect.gen(function* () {
    const reader = yield* SqliteReader;
    const paths = yield* reader.listPaths();

    if (paths.length === 0) {
      yield* Console.log(`No data in ${DB_FILE}`);
      return;
    }

    yield* Console.log(`Stream paths (${paths.length}):`);
    for (const p of paths) {
      const count = yield* reader.countEvents(p);
      yield* Console.log(`  ${p} (${count} events)`);
    }
  }).pipe(
    Effect.provide(ReaderLayer),
    Effect.catchAll(() => Console.log(`No database at ${DB_FILE}`)),
  ),
).pipe(Command.withDescription("List all stream paths in database"));

const dbCommand = Command.make("db").pipe(
  Command.withDescription("SQLite database commands"),
  Command.withSubcommands([dbPathsCommand]),
);

// -------------------------------------------------------------------------------------
// Interactive Commands (require server)
// -------------------------------------------------------------------------------------

const ClientLive = StreamClient.liveLayer({ baseUrl: BASE_URL }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

const messageArg = Args.text({ name: "message" }).pipe(
  Args.withDescription("Message to send"),
  Args.withDefault("Hello!"),
);

const modeOption = Options.choice("mode", ["interrupt", "queue", "background"]).pipe(
  Options.withAlias("m"),
  Options.withDescription("Message mode"),
  Options.withDefault("interrupt" as const),
);

const QUIESCENCE_MS = 2000; // Wait 2s of no events before considering done

const chatCommand = Command.make(
  "chat",
  { message: messageArg, mode: modeOption, path: pathOption },
  ({ message, mode, path }) =>
    Effect.gen(function* () {
      const streamPath = StreamPath.make(path);
      const client = yield* StreamClient.StreamClient;

      // Get current offset before sending
      const initialEvents = yield* client
        .subscribe({ path: streamPath, live: false })
        .pipe(Stream.runCollect);
      const lastEvent = Chunk.last(initialEvents);
      const startOffset = lastEvent._tag === "Some" ? lastEvent.value.offset : undefined;

      const effectiveMode = mode === "interrupt" ? undefined : mode;
      yield* Console.log(`Sending "${message}" (mode=${mode})...`);
      yield* client.append({
        path: streamPath,
        event: UserMessageEvent.make({ content: message, mode: effectiveMode }),
      });

      if (mode === "background") {
        yield* Console.log("Background mode - no response expected");
        return;
      }

      // Wait for response with quiescence detection
      yield* Console.log("Waiting for response...");

      let responseText = "";
      let requestCount = 0;
      let completedCount = 0;

      const subscribeOpts = startOffset
        ? { path: streamPath, live: true, after: startOffset }
        : { path: streamPath, live: true };

      // Use timeoutTo for quiescence detection - switches to empty after no events
      yield* client.subscribe(subscribeOpts).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type.includes("response:sse")) {
              const payload = event.payload as Record<string, unknown>;
              const part = payload.part as Record<string, unknown> | undefined;
              if (part?.type === "text-delta") {
                responseText += part.delta ?? "";
              }
            } else if (event.type.includes("request-started")) {
              requestCount++;
            } else if (
              event.type.includes("request-ended") ||
              event.type.includes("request-cancelled")
            ) {
              completedCount++;
            }
          }),
        ),
        // Quiescence: switch to empty stream after QUIESCENCE_MS of no events
        Stream.timeoutTo(Duration.millis(QUIESCENCE_MS), Stream.empty),
        Stream.runDrain,
        // Overall timeout
        Effect.timeout(Duration.seconds(60)),
      );

      const status = completedCount > 0 ? "completed" : "timeout";
      const statusColor = status === "completed" ? "\x1b[32m" : "\x1b[31m";
      const reqInfo = requestCount > 1 ? ` (${requestCount} requests)` : "";
      yield* Console.log(
        `${statusColor}[${status}]${reqInfo}\x1b[0m ${responseText || "(no text)"}`,
      );
    }).pipe(Effect.provide(ClientLive)),
).pipe(Command.withDescription("Send message and wait for response (with quiescence detection)"));

const configCommand = Command.make("config", { path: pathOption }, ({ path }) =>
  Effect.gen(function* () {
    const streamPath = StreamPath.make(path);
    const client = yield* StreamClient.StreamClient;
    yield* client.append({ path: streamPath, event: ConfigSetEvent.make({ model: "openai" }) });
    yield* Console.log("Enabled openai model");
  }).pipe(Effect.provide(ClientLive)),
).pipe(Command.withDescription("Enable openai model for path"));

const stopCommand = Command.make("stop", { path: pathOption }, ({ path }) =>
  Effect.gen(function* () {
    const streamPath = StreamPath.make(path);
    const client = yield* StreamClient.StreamClient;
    yield* client.append({ path: streamPath, event: CancelRequestEvent.make({}) });
    yield* Console.log("Sent cancel request");
  }).pipe(Effect.provide(ClientLive)),
).pipe(Command.withDescription("Cancel current LLM request"));

const stressCommand = Command.make("stress", { path: pathOption }, ({ path }) =>
  Effect.gen(function* () {
    const streamPath = StreamPath.make(path);
    const client = yield* StreamClient.StreamClient;

    yield* Console.log("=== Stress Test: Interrupt Mode ===");
    yield* client.append({
      path: streamPath,
      event: UserMessageEvent.make({ content: "Count 1-10" }),
    });
    yield* Effect.sleep(Duration.millis(200));
    yield* client.append({
      path: streamPath,
      event: UserMessageEvent.make({ content: "SAY INTERRUPTED" }),
    });
    yield* Effect.sleep(Duration.seconds(3));

    yield* Console.log("=== Stress Test: Queue Mode ===");
    yield* client.append({
      path: streamPath,
      event: UserMessageEvent.make({ content: "Say A" }),
    });
    yield* Effect.sleep(Duration.millis(100));
    yield* client.append({
      path: streamPath,
      event: UserMessageEvent.make({ content: "Say B", mode: "queue" }),
    });
    yield* Effect.sleep(Duration.seconds(5));

    yield* Console.log("=== Stress Test: Background Mode ===");
    yield* client.append({
      path: streamPath,
      event: UserMessageEvent.make({ content: "Say C" }),
    });
    yield* Effect.sleep(Duration.millis(100));
    yield* client.append({
      path: streamPath,
      event: UserMessageEvent.make({ content: "IGNORE THIS", mode: "background" }),
    });
    yield* Effect.sleep(Duration.seconds(3));

    yield* Console.log("=== Stress Test: Stop Mode ===");
    yield* client.append({
      path: streamPath,
      event: UserMessageEvent.make({ content: "Count 1-100" }),
    });
    yield* Effect.sleep(Duration.millis(300));
    yield* client.append({ path: streamPath, event: CancelRequestEvent.make({}) });
    yield* Effect.sleep(Duration.seconds(2));

    yield* Console.log("=== Done! Check results with: debug-cli convo ===");
  }).pipe(Effect.provide(ClientLive)),
).pipe(Command.withDescription("Run stress test of all interjection modes"));

// -------------------------------------------------------------------------------------
// Root Command
// -------------------------------------------------------------------------------------

const app = Command.make("debug-cli").pipe(
  Command.withDescription("Debug CLI for durable-stream event exploration"),
  Command.withSubcommands([
    eventsCommand,
    convoCommand,
    requestsCommand,
    searchCommand,
    dbCommand,
    chatCommand,
    configCommand,
    stopCommand,
    stressCommand,
  ]),
);

// -------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------

const cli = Command.run(app, {
  name: "debug-cli",
  version: "1.0.0",
});

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
