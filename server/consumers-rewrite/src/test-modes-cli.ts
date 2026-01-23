#!/usr/bin/env npx tsx
/**
 * CLI for testing user message interjection modes
 *
 * Usage:
 *   tsx src/test-modes-cli.ts send "message"              # interrupt (default)
 *   tsx src/test-modes-cli.ts send "message" --queue      # queue mode
 *   tsx src/test-modes-cli.ts send "message" --background # background mode
 *   tsx src/test-modes-cli.ts stop                        # cancel current request
 *   tsx src/test-modes-cli.ts config                      # enable openai model
 *   tsx src/test-modes-cli.ts watch                       # watch SSE stream
 */
import { FetchHttpClient } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Stream } from "effect";

import { StreamPath } from "./domain.js";
import { CancelRequestEvent, ConfigSetEvent, UserMessageEvent } from "./events.js";
import * as StreamClient from "./services/stream-client/index.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const PATH = StreamPath.make(process.env.STREAM_PATH ?? "test/modes");

const ClientLive = StreamClient.liveLayer({ baseUrl: BASE_URL }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

const [, , command, ...args] = process.argv;

const program = Effect.gen(function* () {
  const client = yield* StreamClient.StreamClient;

  switch (command) {
    case "config": {
      yield* client.append({ path: PATH, event: ConfigSetEvent.make({ model: "openai" }) });
      yield* Console.log("Enabled openai model");
      break;
    }

    case "send": {
      const content = args[0] ?? "Hello!";
      const mode = args.includes("--queue")
        ? ("queue" as const)
        : args.includes("--background")
          ? ("background" as const)
          : undefined; // default = interrupt

      yield* client.append({ path: PATH, event: UserMessageEvent.make({ content, mode }) });
      yield* Console.log(`Sent "${content}" with mode=${mode ?? "interrupt"}`);
      break;
    }

    case "stop": {
      yield* client.append({ path: PATH, event: CancelRequestEvent.make({}) });
      yield* Console.log("Sent cancel request");
      break;
    }

    case "watch": {
      yield* Console.log(`Watching ${PATH}...`);
      yield* client.subscribe({ path: PATH, live: true }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const typeShort = String(event.type).replace("iterate:", "").replace(":called", "");
            const payloadStr = JSON.stringify(event.payload);
            const preview = payloadStr.length > 80 ? payloadStr.slice(0, 77) + "..." : payloadStr;
            yield* Console.log(`[${event.offset}] ${typeShort}: ${preview}`);
          }),
        ),
      );
      break;
    }

    default:
      yield* Console.log(`
Usage:
  tsx src/test-modes-cli.ts config                      # enable openai model first!
  tsx src/test-modes-cli.ts send "message"              # interrupt (default)
  tsx src/test-modes-cli.ts send "message" --queue      # queue mode
  tsx src/test-modes-cli.ts send "message" --background # background mode
  tsx src/test-modes-cli.ts stop                        # cancel current request
  tsx src/test-modes-cli.ts watch                       # watch SSE stream

Environment:
  BASE_URL=${BASE_URL}
  STREAM_PATH=${PATH}
`);
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(ClientLive)));
