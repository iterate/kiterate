import { Response } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { StreamPath } from "../../domain.js";
import { makeTestSimpleStream } from "../../testing/index.js";
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
    output: { success: true; data: string };
    logs: Array<{ args: unknown[]; timestamp: string }>;
  };
  return payload;
};

const decodeFailed = (event: { payload: unknown }) => {
  const payload = event.payload as {
    requestId: string;
    output: { success: false; error: string };
    logs: Array<{ args: unknown[]; timestamp: string }>;
  };
  return payload;
};

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

it.scoped("parses codemode block and evaluates successfully", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    // Setup codemode processor (we don't need llm-loop for this test)
    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Send a user message (would be done by the system, triggers LLM)
    // For this test, we'll manually append the LLM response events

    // Append request started
    const requestStarted = yield* stream.appendEvent(RequestStartedEvent.make());
    const requestOffset = requestStarted.offset;

    // Emit SSE events with a codemode block
    yield* stream.appendEvent(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({ id: "msg1", delta: "Here's some code:\n" }),
        requestOffset,
      }),
    );
    yield* stream.appendEvent(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({
          id: "msg1",
          delta: "<codemode>\nasync function codemode() {\n  return 42;\n}\n</codemode>",
        }),
        requestOffset,
      }),
    );

    // End the request - this triggers codemode parsing
    yield* stream.appendEvent(RequestEndedEvent.make({ requestOffset }));

    // Wait for codemode events
    const added = yield* stream.waitForEvent(CodeBlockAddedEvent);
    expect(added.payload.code).toContain("return 42");
    expect(added.payload.requestId).toBe(`${requestOffset}.0`);

    const started = yield* stream.waitForEvent(CodeEvalStartedEvent);
    expect(started.payload.requestId).toBe(added.payload.requestId);

    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done = decodeDone(doneEvent);
    expect(done.requestId).toBe(added.payload.requestId);
    expect(done.output.success).toBe(true);
    expect(done.output.data).toBe("42");
  }),
);

it.scoped("captures console.log calls", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    // Setup codemode processor only
    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Append request started and SSE with logging code
    const requestStarted = yield* stream.appendEvent(RequestStartedEvent.make());
    const requestOffset = requestStarted.offset;

    yield* stream.appendEvent(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({
          id: "msg1",
          delta: `<codemode>
async function codemode() {
  console.log("hello", "world");
  console.log(123);
  return "done";
}
</codemode>`,
        }),
        requestOffset,
      }),
    );

    yield* stream.appendEvent(RequestEndedEvent.make({ requestOffset }));

    // Wait for completion
    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done = decodeDone(doneEvent);
    expect(done.output.data).toBe('"done"');
    expect(done.logs).toHaveLength(2);
    expect(done.logs[0]?.args).toEqual(["hello", "world"]);
    expect(done.logs[1]?.args).toEqual([123]);
    expect(done.logs[0]?.timestamp).toBeDefined();
  }),
);

it.scoped("handles evaluation errors", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.appendEvent(RequestStartedEvent.make());
    const requestOffset = requestStarted.offset;

    yield* stream.appendEvent(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({
          id: "msg1",
          delta: `<codemode>
async function codemode() {
  throw new Error("intentional error");
}
</codemode>`,
        }),
        requestOffset,
      }),
    );

    yield* stream.appendEvent(RequestEndedEvent.make({ requestOffset }));

    // Wait for failure
    const failedEvent = yield* stream.waitForEvent(CodeEvalFailedEvent);
    const failed = decodeFailed(failedEvent);
    expect(failed.output.success).toBe(false);
    expect(failed.output.error).toContain("intentional error");
  }),
);

it.scoped("handles missing codemode function", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.appendEvent(RequestStartedEvent.make());
    const requestOffset = requestStarted.offset;

    yield* stream.appendEvent(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({
          id: "msg1",
          delta: `<codemode>
const x = 42;
</codemode>`,
        }),
        requestOffset,
      }),
    );

    yield* stream.appendEvent(RequestEndedEvent.make({ requestOffset }));

    const failedEvent = yield* stream.waitForEvent(CodeEvalFailedEvent);
    const failed = decodeFailed(failedEvent);
    expect(failed.output.success).toBe(false);
    expect(failed.output.error).toContain('async function named "codemode"');
  }),
);

it.scoped("handles multiple codemode blocks", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.appendEvent(RequestStartedEvent.make());
    const requestOffset = requestStarted.offset;

    yield* stream.appendEvent(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({
          id: "msg1",
          delta: `First block:
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
</codemode>`,
        }),
        requestOffset,
      }),
    );

    yield* stream.appendEvent(RequestEndedEvent.make({ requestOffset }));

    // Wait for both code blocks
    const added1 = yield* stream.waitForEvent(CodeBlockAddedEvent);
    const added2 = yield* stream.waitForEvent(CodeBlockAddedEvent);

    expect(added1.payload.requestId).toBe(`${requestOffset}.0`);
    expect(added2.payload.requestId).toBe(`${requestOffset}.1`);

    // Wait for both completions
    const done1Event = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done2Event = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done1 = decodeDone(done1Event);
    const done2 = decodeDone(done2Event);

    expect(done1.output.data).toBe("1");
    expect(done2.output.data).toBe("2");
  }),
);

it.scoped("handles non-serializable return values", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    const requestStarted = yield* stream.appendEvent(RequestStartedEvent.make());
    const requestOffset = requestStarted.offset;

    yield* stream.appendEvent(
      ResponseSseEvent.make({
        part: Response.textDeltaPart({
          id: "msg1",
          delta: `<codemode>
async function codemode() {
  const obj = {};
  obj.self = obj; // circular reference
  return obj;
}
</codemode>`,
        }),
        requestOffset,
      }),
    );

    yield* stream.appendEvent(RequestEndedEvent.make({ requestOffset }));

    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const done = decodeDone(doneEvent);
    expect(done.output.success).toBe(true);
    expect(done.output.data).toContain("non-serializable");
  }),
);
