import { Response } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import dedent from "dedent";
import { Effect } from "effect";

import { Offset, StreamPath } from "../../domain.js";
import { UserMessageEvent } from "../../events.js";
import { makeTestEventStream, type TestEventStream } from "../../testing/index.js";
import { RequestEndedEvent, RequestStartedEvent, ResponseSseEvent } from "../llm-loop/events.js";
import {
  CodeBlockAddedEvent,
  CodeEvalDoneEvent,
  CodeEvalFailedEvent,
  CodeEvalStartedEvent,
} from "./events.js";
import { CodemodeProcessor } from "./processor.js";

// Helper to decode event payloads with proper typing
const decodeDone = (event: { payload: unknown }) => {
  const payload = event.payload as {
    requestId: string;
    success: true;
    data: string;
    logs: Array<{ args: unknown[]; timestamp: string }>;
  };
  return payload;
};

const decodeFailed = (event: { payload: unknown }) => {
  const payload = event.payload as {
    requestId: string;
    success: false;
    error: string;
    logs: Array<{ args: unknown[]; timestamp: string }>;
  };
  return payload;
};

// Helper to emit a codemode block
const emitCodemodeBlock = (stream: TestEventStream, requestOffset: Offset, code: string) =>
  Effect.gen(function* () {
    yield* stream.append(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({ id: "msg1", delta: code }),
        requestOffset,
      }),
    );
    yield* stream.append(RequestEndedEvent.make({ requestOffset }));
  });

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

it.scoped("parses codemode block and evaluates successfully", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    const requestOffset = requestStarted.offset;

    // Emit SSE events with a codemode block
    yield* stream.append(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({ id: "msg1", delta: "Here's some code:\n" }),
        requestOffset,
      }),
    );
    yield* stream.append(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({
          id: "msg1",
          delta: "<codemode>\nasync function codemode() {\n  return 42;\n}\n</codemode>",
        }),
        requestOffset,
      }),
    );

    yield* stream.append(RequestEndedEvent.make({ requestOffset }));

    // Wait for codemode events
    const added = yield* stream.waitForEvent(CodeBlockAddedEvent);
    expect(added.payload.code).toContain("return 42");
    expect(added.payload.requestId).toBe(`${requestOffset}.0`);

    const started = yield* stream.waitForEvent(CodeEvalStartedEvent);
    expect(started.payload.requestId).toBe(added.payload.requestId);

    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done = decodeDone(doneEvent);
    expect(done.requestId).toBe(added.payload.requestId);
    expect(done.success).toBe(true);
    expect(done.data).toBe("42");

    // Should append a user message summarizing the result
    const userMsg = yield* stream.waitForEvent(UserMessageEvent);
    expect(userMsg.payload.content).toContain("completed successfully");
    expect(userMsg.payload.content).toContain("42");
  }),
);

it.scoped("captures console.log calls", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          console.log("hello", "world");
          console.log(123);
          return "done";
        }
        </codemode>
      `,
    );

    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done = decodeDone(doneEvent);
    expect(done.data).toBe('"done"');
    expect(done.logs).toHaveLength(2);
    expect(done.logs[0]?.args).toEqual(["hello", "world"]);
    expect(done.logs[1]?.args).toEqual([123]);
    expect(done.logs[0]?.timestamp).toBeDefined();
  }),
);

it.scoped("handles evaluation errors", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          throw new Error("intentional error");
        }
        </codemode>
      `,
    );

    const failedEvent = yield* stream.waitForEvent(CodeEvalFailedEvent);
    const failed = decodeFailed(failedEvent);
    expect(failed.success).toBe(false);
    expect(failed.error).toContain("intentional error");

    // Should append a user message about the failure
    const userMsg = yield* stream.waitForEvent(UserMessageEvent);
    expect(userMsg.payload.content).toContain("failed");
    expect(userMsg.payload.content).toContain("intentional error");
  }),
);

it.scoped("handles missing codemode function", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        const x = 42;
        </codemode>
      `,
    );

    const failedEvent = yield* stream.waitForEvent(CodeEvalFailedEvent);
    const failed = decodeFailed(failedEvent);
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('async function named "codemode"');
  }),
);

it.scoped("handles multiple codemode blocks", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        First block:
        <codemode>
        async function codemode() {
          return 1;
        }
        </codemode>

        Second block:
        <codemode>
        async function codemode() {
          return 2;
        }
        </codemode>
      `,
    );

    // Wait for both code blocks
    const added1 = yield* stream.waitForEvent(CodeBlockAddedEvent);
    const added2 = yield* stream.waitForEvent(CodeBlockAddedEvent);

    expect(added1.payload.requestId).toBe(`${requestStarted.offset}.0`);
    expect(added2.payload.requestId).toBe(`${requestStarted.offset}.1`);

    // Wait for both completions
    const done1Event = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done2Event = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done1 = decodeDone(done1Event);
    const done2 = decodeDone(done2Event);

    expect(done1.data).toBe("1");
    expect(done2.data).toBe("2");
  }),
);

it.scoped("handles non-serializable return values", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          const obj = {};
          obj.self = obj; // circular reference
          return obj;
        }
        </codemode>
      `,
    );

    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done = decodeDone(doneEvent);
    expect(done.success).toBe(true);
    expect(done.data).toContain("non-serializable");
  }),
);

// -------------------------------------------------------------------------------------
// User Message Summary Tests
// -------------------------------------------------------------------------------------

it.scoped("appends user message with output after successful execution", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          return { status: "ok", count: 42 };
        }
        </codemode>
      `,
    );

    yield* stream.waitForEvent(CodeEvalDoneEvent);

    const userMsg = yield* stream.waitForEvent(UserMessageEvent);
    expect(userMsg.payload.content).toContain("[Codemode execution completed successfully]");
    expect(userMsg.payload.content).toContain("Output:");
    expect(userMsg.payload.content).toContain('"status":"ok"');
    expect(userMsg.payload.content).toContain('"count":42');
    expect(userMsg.payload.content).toContain("Please let the user know how it went");
  }),
);

it.scoped("appends user message with error after failed execution", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          throw new Error("database connection failed");
        }
        </codemode>
      `,
    );

    yield* stream.waitForEvent(CodeEvalFailedEvent);

    const userMsg = yield* stream.waitForEvent(UserMessageEvent);
    expect(userMsg.payload.content).toContain("[Codemode execution failed]");
    expect(userMsg.payload.content).toContain("Error:");
    expect(userMsg.payload.content).toContain("database connection failed");
    expect(userMsg.payload.content).toContain("try again if appropriate");
  }),
);

it.scoped("includes console logs in user message summary", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          console.log("Starting process...");
          console.log("Step 1 complete", { items: 5 });
          console.log("Finished!");
          return "success";
        }
        </codemode>
      `,
    );

    yield* stream.waitForEvent(CodeEvalDoneEvent);

    const userMsg = yield* stream.waitForEvent(UserMessageEvent);
    expect(userMsg.payload.content).toContain("Console logs:");
    expect(userMsg.payload.content).toContain("Starting process...");
    expect(userMsg.payload.content).toContain("Step 1 complete");
    expect(userMsg.payload.content).toContain("items");
    expect(userMsg.payload.content).toContain("Finished!");
  }),
);

it.scoped("includes console logs in failed execution summary", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          console.log("Attempting operation...");
          console.log("Warning: retrying...");
          throw new Error("max retries exceeded");
        }
        </codemode>
      `,
    );

    yield* stream.waitForEvent(CodeEvalFailedEvent);

    const userMsg = yield* stream.waitForEvent(UserMessageEvent);
    expect(userMsg.payload.content).toContain("[Codemode execution failed]");
    expect(userMsg.payload.content).toContain("Console logs:");
    expect(userMsg.payload.content).toContain("Attempting operation...");
    expect(userMsg.payload.content).toContain("Warning: retrying...");
    expect(userMsg.payload.content).toContain("max retries exceeded");
  }),
);
