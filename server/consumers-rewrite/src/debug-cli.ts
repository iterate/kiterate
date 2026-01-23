#!/usr/bin/env npx tsx
/**
 * Debug CLI for exploring event streams and testing interjection modes.
 *
 * YAML Queries:
 *   tsx src/debug-cli.ts events [--type TYPE] [--around OFFSET] [--last N]
 *   tsx src/debug-cli.ts convo                   # show conversation only
 *   tsx src/debug-cli.ts requests                # show request lifecycle
 *   tsx src/debug-cli.ts search PATTERN          # grep through YAML
 *
 * Interactive Testing:
 *   tsx src/debug-cli.ts chat "message"          # send + wait for response
 *   tsx src/debug-cli.ts chat "message" --queue  # with mode
 *   tsx src/debug-cli.ts stress                  # rapid-fire mode testing
 *
 * Environment:
 *   STREAM_PATH=test/modes  (default)
 *   BASE_URL=http://localhost:3000  (default)
 */
import { FetchHttpClient } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import * as fs from "fs";

import { Chunk, Console, Duration, Effect, Layer, Stream } from "effect";

import { StreamPath } from "./domain.js";
import { CancelRequestEvent, ConfigSetEvent, UserMessageEvent } from "./events.js";
import * as StreamClient from "./services/stream-client/index.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

// Path can be set via:
// 1. First positional arg that looks like a path (contains / or matches existing .yaml)
// 2. STREAM_PATH env var
// 3. Default: "test/modes"
function detectStreamPath(): string {
  // Check if first arg looks like a path (before command)
  const pathArg = process.argv[2];
  if (
    pathArg &&
    !pathArg.startsWith("-") &&
    (pathArg.includes("/") || fs.existsSync(`.data/streams/${pathArg.replace(/\//g, "_")}.yaml`))
  ) {
    // Shift args so command parsing works
    process.argv.splice(2, 1);
    return pathArg;
  }
  return process.env.STREAM_PATH ?? "test/modes";
}

const STREAM_PATH = detectStreamPath();
const PATH = StreamPath.make(STREAM_PATH);
const YAML_FILE = `.data/streams/${STREAM_PATH.replace(/\//g, "_")}.yaml`;

const ClientLive = StreamClient.liveLayer({ baseUrl: BASE_URL }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

// -------------------------------------------------------------------------------------
// YAML Query Helpers
// -------------------------------------------------------------------------------------

interface ParsedEvent {
  type: string;
  offset: string;
  payload: Record<string, unknown>;
  raw: string;
}

function parseYamlEvents(content: string): ParsedEvent[] {
  const docs = content.split(/^---$/m).filter((d) => d.trim());
  return docs.map((raw) => {
    const typeMatch = raw.match(/^type:\s*(.+)$/m);
    const offsetMatch = raw.match(/^offset:\s*"(.+)"$/m);
    const type = typeMatch?.[1] ?? "unknown";
    const offset = offsetMatch?.[1] ?? "0";

    // Extract payload (simple approach - just grab content/delta if present)
    const contentMatch = raw.match(/content:\s*(.+)/);
    const deltaMatch = raw.match(/delta:\s*(.+)/);
    const reasonMatch = raw.match(/reason:\s*(.+)/);

    return {
      type,
      offset,
      payload: {
        content: contentMatch?.[1],
        delta: deltaMatch?.[1],
        reason: reasonMatch?.[1],
      },
      raw,
    };
  });
}

function shortType(type: string): string {
  return type.replace("iterate:", "").replace(":called", "").replace("llm-loop:", "");
}

// -------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------

const commands: Record<
  string,
  (args: string[]) => Effect.Effect<void, unknown, StreamClient.StreamClient>
> = {
  // Show conversation (user/assistant messages only)
  convo: () =>
    Effect.sync(() => {
      if (!fs.existsSync(YAML_FILE)) {
        console.log(`No file at ${YAML_FILE}`);
        return;
      }
      const content = fs.readFileSync(YAML_FILE, "utf-8");
      const events = parseYamlEvents(content);

      let currentAssistant = "";
      for (const ev of events) {
        if (ev.type.includes("send-user-message")) {
          if (currentAssistant) {
            console.log(`\x1b[32mAssistant:\x1b[0m ${currentAssistant}`);
            currentAssistant = "";
          }
          const contentMatch = ev.raw.match(/content:\s*(.+)/);
          const modeMatch = ev.raw.match(/mode:\s*(\w+)/);
          const mode = modeMatch?.[1] ? ` [${modeMatch[1]}]` : "";
          console.log(`\x1b[34mUser${mode}:\x1b[0m ${contentMatch?.[1] ?? "?"}`);
        } else if (ev.type.includes("response:sse")) {
          const delta = ev.payload.delta;
          if (delta && typeof delta === "string") {
            currentAssistant += delta.replace(/^"|"$/g, "");
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
    }),

  // Show request lifecycle
  requests: () =>
    Effect.sync(() => {
      if (!fs.existsSync(YAML_FILE)) {
        console.log(`No file at ${YAML_FILE}`);
        return;
      }
      const content = fs.readFileSync(YAML_FILE, "utf-8");
      const events = parseYamlEvents(content);

      const requests: Map<string, { started?: string; ended?: string; status: string }> = new Map();

      for (const ev of events) {
        if (ev.type.includes("request-started")) {
          requests.set(ev.offset, { started: ev.offset, status: "started" });
        } else if (ev.type.includes("request-ended")) {
          const reqOffset = ev.raw.match(/requestOffset:\s*"(.+)"/)?.[1];
          if (reqOffset && requests.has(reqOffset)) {
            requests.get(reqOffset)!.ended = ev.offset;
            requests.get(reqOffset)!.status = "completed";
          }
        } else if (ev.type.includes("request-cancelled")) {
          const reqOffset = ev.raw.match(/requestOffset:\s*"(.+)"/)?.[1];
          const reason = ev.payload.reason ?? "unknown";
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
    }),

  // Show events with filters
  events: (args) =>
    Effect.sync(() => {
      if (!fs.existsSync(YAML_FILE)) {
        console.log(`No file at ${YAML_FILE}`);
        return;
      }
      const content = fs.readFileSync(YAML_FILE, "utf-8");
      let events = parseYamlEvents(content);

      // Parse filters
      const typeFilter = args.find((a) => a.startsWith("--type="))?.split("=")[1];
      const aroundOffset = args.find((a) => a.startsWith("--around="))?.split("=")[1];
      const lastN = parseInt(args.find((a) => a.startsWith("--last="))?.split("=")[1] ?? "20", 10);

      if (typeFilter) {
        events = events.filter((e) => e.type.includes(typeFilter));
      }

      if (aroundOffset) {
        const idx = events.findIndex((e) => e.offset === aroundOffset);
        if (idx >= 0) {
          events = events.slice(Math.max(0, idx - 5), idx + 6);
        }
      } else {
        events = events.slice(-lastN);
      }

      for (const ev of events) {
        const delta = ev.payload.delta ? ` δ=${ev.payload.delta}` : "";
        const reason = ev.payload.reason ? ` reason=${ev.payload.reason}` : "";
        console.log(`[${ev.offset}] ${shortType(ev.type)}${delta}${reason}`);
      }
    }),

  // Search YAML
  search: (args) =>
    Effect.sync(() => {
      const pattern = args[0];
      if (!pattern) {
        console.log("Usage: search PATTERN");
        return;
      }
      if (!fs.existsSync(YAML_FILE)) {
        console.log(`No file at ${YAML_FILE}`);
        return;
      }
      const content = fs.readFileSync(YAML_FILE, "utf-8");
      const events = parseYamlEvents(content);
      const matches = events.filter((e) => e.raw.includes(pattern));
      console.log(`Found ${matches.length} events matching "${pattern}":`);
      for (const ev of matches.slice(-10)) {
        console.log(`  [${ev.offset}] ${shortType(ev.type)}`);
      }
    }),

  // Interactive chat - send message and wait for response
  chat: (args) =>
    Effect.gen(function* () {
      const content = args.find((a) => !a.startsWith("--")) ?? "Hello!";
      const mode = args.includes("--queue")
        ? ("queue" as const)
        : args.includes("--background")
          ? ("background" as const)
          : undefined;

      const client = yield* StreamClient.StreamClient;

      // Get current offset before sending
      const initialEvents = yield* client
        .subscribe({ path: PATH, live: false })
        .pipe(Stream.runCollect);
      const lastEvent = Chunk.last(initialEvents);
      const startOffset = lastEvent._tag === "Some" ? lastEvent.value.offset : undefined;

      yield* Console.log(`Sending "${content}" (mode=${mode ?? "interrupt"})...`);
      yield* client.append({ path: PATH, event: UserMessageEvent.make({ content, mode }) });

      if (mode === "background") {
        yield* Console.log("Background mode - no response expected");
        return;
      }

      // Wait for response with quiescence detection
      yield* Console.log("Waiting for response...");

      let responseText = "";
      let status = "pending";

      const subscribeOpts = startOffset
        ? { path: PATH, live: true, after: startOffset }
        : { path: PATH, live: true };
      yield* client.subscribe(subscribeOpts).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type.includes("response:sse")) {
              const payload = event.payload as Record<string, unknown>;
              const part = payload.part as Record<string, unknown> | undefined;
              if (part?.type === "text-delta") {
                responseText += part.delta ?? "";
              }
            } else if (event.type.includes("request-ended")) {
              status = "completed";
            } else if (event.type.includes("request-cancelled")) {
              status = "cancelled";
            }
          }),
        ),
        Stream.takeUntil(() => status !== "pending"),
        Stream.runDrain,
        Effect.timeoutTo({
          duration: Duration.seconds(30),
          onSuccess: () => "ok",
          onTimeout: () => "timeout",
        }),
      );

      const statusColor = status === "completed" ? "\x1b[32m" : "\x1b[31m";
      yield* Console.log(`${statusColor}[${status}]\x1b[0m ${responseText || "(no text)"}`);
    }),

  // Enable openai model
  config: () =>
    Effect.gen(function* () {
      const client = yield* StreamClient.StreamClient;
      yield* client.append({ path: PATH, event: ConfigSetEvent.make({ model: "openai" }) });
      yield* Console.log("Enabled openai model");
    }),

  // Send cancel request
  stop: () =>
    Effect.gen(function* () {
      const client = yield* StreamClient.StreamClient;
      yield* client.append({ path: PATH, event: CancelRequestEvent.make({}) });
      yield* Console.log("Sent cancel request");
    }),

  // Stress test - rapid fire messages with different modes
  stress: () =>
    Effect.gen(function* () {
      const client = yield* StreamClient.StreamClient;

      yield* Console.log("=== Stress Test: Interrupt Mode ===");
      yield* client.append({ path: PATH, event: UserMessageEvent.make({ content: "Count 1-10" }) });
      yield* Effect.sleep(Duration.millis(200));
      yield* client.append({
        path: PATH,
        event: UserMessageEvent.make({ content: "SAY INTERRUPTED" }),
      });
      yield* Effect.sleep(Duration.seconds(3));

      yield* Console.log("=== Stress Test: Queue Mode ===");
      yield* client.append({ path: PATH, event: UserMessageEvent.make({ content: "Say A" }) });
      yield* Effect.sleep(Duration.millis(100));
      yield* client.append({
        path: PATH,
        event: UserMessageEvent.make({ content: "Say B", mode: "queue" }),
      });
      yield* Effect.sleep(Duration.seconds(5));

      yield* Console.log("=== Stress Test: Background Mode ===");
      yield* client.append({ path: PATH, event: UserMessageEvent.make({ content: "Say C" }) });
      yield* Effect.sleep(Duration.millis(100));
      yield* client.append({
        path: PATH,
        event: UserMessageEvent.make({ content: "IGNORE THIS", mode: "background" }),
      });
      yield* Effect.sleep(Duration.seconds(3));

      yield* Console.log("=== Stress Test: Stop Mode ===");
      yield* client.append({
        path: PATH,
        event: UserMessageEvent.make({ content: "Count 1-100" }),
      });
      yield* Effect.sleep(Duration.millis(300));
      yield* client.append({ path: PATH, event: CancelRequestEvent.make({}) });
      yield* Effect.sleep(Duration.seconds(2));

      yield* Console.log("=== Done! Check results with: tsx src/debug-cli.ts convo ===");
    }),

  help: () =>
    Effect.sync(() => {
      console.log(`
Debug CLI for event streams

Usage:
  tsx src/debug-cli.ts [PATH] COMMAND [ARGS]

Path Selection (in priority order):
  1. First arg if it contains "/" or matches existing .yaml file
  2. STREAM_PATH env var
  3. Default: "test/modes"

Current: ${STREAM_PATH} → ${YAML_FILE}

YAML Queries (offline):
  events [--type=TYPE] [--around=OFFSET] [--last=N]  Show events
  convo                                               Show conversation only
  requests                                            Show request lifecycle
  search PATTERN                                      Search YAML content

Interactive (requires server at ${BASE_URL}):
  config                                              Enable openai model
  chat "message" [--queue|--background]               Send + wait for response
  stop                                                Cancel current request
  stress                                              Run stress test of all modes

Examples:
  tsx src/debug-cli.ts convo                    # default path
  tsx src/debug-cli.ts chat/room1 convo         # specific path
  STREAM_PATH=codey tsx src/debug-cli.ts convo  # via env var
`);
    }),
};

// -------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------

const [, , command, ...args] = process.argv;
const cmd = commands[command ?? "help"] ?? commands.help;

NodeRuntime.runMain(cmd(args).pipe(Effect.provide(ClientLive)));
