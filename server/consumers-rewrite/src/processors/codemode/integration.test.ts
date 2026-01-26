/**
 * Codemode Integration Tests
 *
 * Tests the full codemode execution pipeline with mocked external dependencies.
 * These tests verify that:
 * 1. Tools can be registered and invoked with mocked fetch/execa
 * 2. Deferred blocks poll correctly with time ticks
 * 3. The emit() function works for creating deferred blocks from code
 */
import { Response as AiResponse } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import dedent from "dedent";
import { Effect, Option } from "effect";

import { Offset, StreamPath } from "../../domain.js";
import { DeveloperMessageEvent } from "../../events.js";
import { makeTestEventStream, type TestEventStream } from "../../testing/index.js";
import { RequestEndedEvent, RequestStartedEvent, ResponseSseEvent } from "../llm-loop/events.js";
import { TimeTickEvent } from "../clock/events.js";
import {
  CodeEvalDoneEvent,
  CodeEvalFailedEvent,
  DeferredBlockAddedEvent,
  DeferredCompletedEvent,
  DeferredPollAttemptedEvent,
  ToolRegisteredEvent,
} from "./events.js";
import { CodemodeProcessor } from "./processor.js";
import { testLayer, createMockFetch, createMockExeca } from "./runtime.js";

// -------------------------------------------------------------------------------------
// Test Helpers
// -------------------------------------------------------------------------------------

/** Emit a codemode block and wait for evaluation to complete */
const emitCodemodeBlock = (stream: TestEventStream, requestOffset: Offset, code: string) =>
  Effect.gen(function* () {
    yield* stream.append(
      ResponseSseEvent.make({
        part: AiResponse.textDeltaPart({ id: "msg1", delta: code }),
        requestOffset,
      }),
    );
    yield* stream.append(RequestEndedEvent.make({ requestOffset }));
  });

/** Register a tool via event */
const registerTool = (
  stream: TestEventStream,
  tool: {
    name: string;
    description: string;
    parametersJsonSchema: unknown;
    implementation: string;
    returnDescription?: string;
  },
) =>
  stream.append(
    ToolRegisteredEvent.make({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parametersJsonSchema,
      returnDescription: tool.returnDescription
        ? Option.some(tool.returnDescription)
        : Option.none(),
      implementation: tool.implementation,
    }),
  );

/** Emit a time tick event */
const emitTimeTick = (stream: TestEventStream, elapsedSeconds: number) =>
  stream.append(TimeTickEvent.make({ elapsedSeconds }));

// -------------------------------------------------------------------------------------
// Integration Tests: Mocked Fetch
// -------------------------------------------------------------------------------------

it.scoped("tool can call mocked fetch and receive controlled response", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test-fetch"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Register a tool that fetches from an API
    yield* registerTool(stream, {
      name: "fetchWeather",
      description: "Fetches weather data for a city",
      parametersJsonSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
      },
      implementation: `
        const response = await fetch(\`https://api.weather.com/v1/\${params.city}\`);
        return await response.json();
      `,
      returnDescription: "Weather data object",
    });

    // Start a request and invoke the tool
    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          const weather = await fetchWeather({ city: "london" });
          return weather;
        }
        </codemode>
      `,
    );

    // Wait for successful completion
    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const result = JSON.parse(doneEvent.payload.data as string);

    expect(result).toEqual({
      city: "london",
      temperature: 18,
      condition: "cloudy",
    });
  }).pipe(
    Effect.provide(
      testLayer({
        fetch: createMockFetch([
          {
            pattern: "api.weather.com",
            response: new Response(
              JSON.stringify({ city: "london", temperature: 18, condition: "cloudy" }),
              { headers: { "Content-Type": "application/json" } },
            ),
          },
        ]),
      }),
    ),
  ),
);

it.scoped("tool receives error when fetch fails", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test-fetch-error"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Register a tool that fetches from an API
    yield* registerTool(stream, {
      name: "fetchData",
      description: "Fetches data from API",
      parametersJsonSchema: { type: "object", properties: {} },
      implementation: `
        const response = await fetch("https://api.example.com/data");
        if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
        return await response.json();
      `,
    });

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          return await fetchData({});
        }
        </codemode>
      `,
    );

    // Should fail with the mocked error
    const failedEvent = yield* stream.waitForEvent(CodeEvalFailedEvent);
    expect(failedEvent.payload.error).toContain("HTTP 500");
  }).pipe(
    Effect.provide(
      testLayer({
        fetch: createMockFetch([
          {
            pattern: "api.example.com",
            response: new Response("Internal Server Error", { status: 500 }),
          },
        ]),
      }),
    ),
  ),
);

// -------------------------------------------------------------------------------------
// Integration Tests: Mocked Execa
// -------------------------------------------------------------------------------------

it.scoped("tool can call mocked execa and receive controlled output", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test-execa"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Register a tool that runs a shell command
    yield* registerTool(stream, {
      name: "runGitStatus",
      description: "Runs git status",
      parametersJsonSchema: { type: "object", properties: {} },
      implementation: `
        const result = await execa("git", ["status", "--porcelain"]);
        return { files: result.stdout.split("\\n").filter(Boolean) };
      `,
    });

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          return await runGitStatus({});
        }
        </codemode>
      `,
    );

    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const result = JSON.parse(doneEvent.payload.data as string);

    expect(result).toEqual({
      files: ["M src/index.ts", "A src/new-file.ts"],
    });
  }).pipe(
    Effect.provide(
      testLayer({
        execa: createMockExeca([
          {
            command: "git",
            result: { stdout: "M src/index.ts\nA src/new-file.ts" },
          },
        ]),
      }),
    ),
  ),
);

// -------------------------------------------------------------------------------------
// Integration Tests: Environment Variables
// -------------------------------------------------------------------------------------

it.scoped("tool can access mocked environment variables", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test-env"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Register a tool that reads env vars
    yield* registerTool(stream, {
      name: "getApiKey",
      description: "Gets the API key from environment",
      parametersJsonSchema: { type: "object", properties: {} },
      implementation: `
        return { apiKey: process.env.MY_API_KEY, nodeEnv: process.env.NODE_ENV };
      `,
    });

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          return await getApiKey({});
        }
        </codemode>
      `,
    );

    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const result = JSON.parse(doneEvent.payload.data as string);

    expect(result).toEqual({
      apiKey: "test-secret-key-123",
      nodeEnv: "test",
    });
  }).pipe(
    Effect.provide(
      testLayer({
        env: {
          MY_API_KEY: "test-secret-key-123",
          NODE_ENV: "test",
        },
      }),
    ),
  ),
);

// -------------------------------------------------------------------------------------
// Integration Tests: Deferred Blocks with Time Ticks
// -------------------------------------------------------------------------------------

it.scoped("deferred block polls on time ticks and completes when API returns ready", () => {
  // Track poll count to return different responses
  let pollCount = 0;

  const mockFetch = createMockFetch([
    {
      pattern: "api.research.com/status",
      response: () => {
        pollCount++;
        if (pollCount < 3) {
          return new Response(JSON.stringify({ status: "pending", progress: pollCount * 33 }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ status: "complete", result: "Research findings here" }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  ]);

  return Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test-deferred"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Emit a deferred block that polls an API
    yield* stream.append(
      DeferredBlockAddedEvent.make({
        code: dedent`
          async function codemode() {
            const response = await fetch("https://api.research.com/status/job123");
            const data = await response.json();
            console.log("Poll result:", data.status);
            if (data.status === "complete") {
              return data.result;
            }
            return null; // Keep polling
          }
        `,
        checkIntervalSeconds: 10,
        maxAttempts: 5,
        description: "Polling research job",
      }),
    );

    // Emit time ticks to trigger polling
    yield* emitTimeTick(stream, 10);
    const poll1 = yield* stream.waitForEvent(DeferredPollAttemptedEvent);
    expect(poll1.payload.attemptNumber).toBe(1);
    expect(poll1.payload.result).toBeNull();

    yield* emitTimeTick(stream, 20);
    const poll2 = yield* stream.waitForEvent(DeferredPollAttemptedEvent);
    expect(poll2.payload.attemptNumber).toBe(2);
    expect(poll2.payload.result).toBeNull();

    yield* emitTimeTick(stream, 30);
    const poll3 = yield* stream.waitForEvent(DeferredPollAttemptedEvent);
    expect(poll3.payload.attemptNumber).toBe(3);
    expect(poll3.payload.result).toBe('"Research findings here"');

    // Should emit completion event
    const completed = yield* stream.waitForEvent(DeferredCompletedEvent);
    expect(completed.payload.result).toBe('"Research findings here"');

    // Should notify the LLM - there will be status messages for pending polls (1, 2),
    // then a completion message on poll 3. Total: 3 DeveloperMessageEvents.
    yield* stream.waitForEventCount(DeveloperMessageEvent, 2); // Skip the 2 status messages
    const notification = yield* stream.waitForEvent(DeveloperMessageEvent);
    expect(notification.payload.content).toContain("Deferred task completed");
    expect(notification.payload.content).toContain("Research findings here");
  }).pipe(Effect.provide(testLayer({ fetch: mockFetch })));
});

it.scoped("codemode can emit deferred block via emit() with mocked dependencies", () => {
  let pollCount = 0;

  const mockFetch = createMockFetch([
    {
      pattern: "api.longprocess.com",
      response: () => {
        pollCount++;
        if (pollCount < 2) {
          return new Response(JSON.stringify({ done: false }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ done: true, data: "Final result" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  ]);

  return Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test-emit-deferred"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Codemode that emits a deferred block
    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          emit({
            type: "iterate:codemode:deferred-block-added",
            payload: {
              code: \`
                async function codemode() {
                  const res = await fetch("https://api.longprocess.com/check");
                  const data = await res.json();
                  return data.done ? data.data : null;
                }
              \`,
              checkIntervalSeconds: 5,
              maxAttempts: 10,
              description: "Checking long process",
            },
          });
          return "Deferred block started";
        }
        </codemode>
      `,
    );

    // Wait for the codemode to complete
    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    expect(doneEvent.payload.data).toBe('"Deferred block started"');

    // Should have emitted the deferred block
    const deferredAdded = yield* stream.waitForEvent(DeferredBlockAddedEvent);
    expect(deferredAdded.payload.description).toBe("Checking long process");

    // Now trigger time ticks
    yield* emitTimeTick(stream, 5);
    const poll1 = yield* stream.waitForEvent(DeferredPollAttemptedEvent);
    expect(poll1.payload.result).toBeNull();

    yield* emitTimeTick(stream, 10);
    const poll2 = yield* stream.waitForEvent(DeferredPollAttemptedEvent);
    expect(poll2.payload.result).toBe('"Final result"');

    const completed = yield* stream.waitForEvent(DeferredCompletedEvent);
    expect(completed.payload.result).toBe('"Final result"');
  }).pipe(Effect.provide(testLayer({ fetch: mockFetch })));
});

// -------------------------------------------------------------------------------------
// Integration Tests: Combined Mocks
// -------------------------------------------------------------------------------------

it.scoped("full flow: tool with fetch + execa + env", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test-combined"));

    yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Register a tool that uses all three
    yield* registerTool(stream, {
      name: "deployApp",
      description: "Deploys the app using git and API",
      parametersJsonSchema: {
        type: "object",
        properties: { branch: { type: "string" } },
        required: ["branch"],
      },
      implementation: `
        // Check git status
        const gitResult = await execa("git", ["rev-parse", "HEAD"]);
        const commitHash = gitResult.stdout.trim();
        
        // Call deploy API with auth
        const response = await fetch("https://deploy.example.com/deploy", {
          method: "POST",
          headers: {
            "Authorization": \`Bearer \${process.env.DEPLOY_TOKEN}\`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ branch: params.branch, commit: commitHash }),
        });
        
        return await response.json();
      `,
    });

    const requestStarted = yield* stream.append(RequestStartedEvent.make({ requestParams: [] }));
    yield* emitCodemodeBlock(
      stream,
      requestStarted.offset,
      dedent`
        <codemode>
        async function codemode() {
          return await deployApp({ branch: "main" });
        }
        </codemode>
      `,
    );

    const doneEvent = yield* stream.waitForEvent(CodeEvalDoneEvent);
    const result = JSON.parse(doneEvent.payload.data as string);

    expect(result).toEqual({
      success: true,
      deployId: "deploy-123",
      message: "Deployed abc123 to main",
    });
  }).pipe(
    Effect.provide(
      testLayer({
        fetch: createMockFetch([
          {
            pattern: "deploy.example.com",
            response: (req) => {
              // Verify the request has the auth header
              const auth = req.headers.get("Authorization");
              if (auth !== "Bearer test-deploy-token") {
                return new Response("Unauthorized", { status: 401 });
              }
              return new Response(
                JSON.stringify({
                  success: true,
                  deployId: "deploy-123",
                  message: "Deployed abc123 to main",
                }),
                { headers: { "Content-Type": "application/json" } },
              );
            },
          },
        ]),
        execa: createMockExeca([
          {
            command: /git.*rev-parse/,
            result: { stdout: "abc123" },
          },
        ]),
        env: {
          DEPLOY_TOKEN: "test-deploy-token",
        },
      }),
    ),
  ),
);
