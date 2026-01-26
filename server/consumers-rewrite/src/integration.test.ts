/**
 * Full Integration Tests
 *
 * Tests the interaction between all processors:
 * - LlmLoopProcessor: Handles LLM requests/responses
 * - CodemodeProcessor: Evaluates code blocks from LLM responses
 * - ClockProcessor: Emits time ticks for deferred block polling
 *
 * Uses mocked dependencies:
 * - TestLanguageModel: Mock LLM that allows controlling responses
 * - TestClock: Mock clock that allows controlling time
 * - CodeExecutionRuntime: Mock fetch/execa/env for code execution
 */
import { Response as AiResponse } from "@effect/ai";
// Use AiResponse for LLM stream parts, global Response for fetch mocks
import { describe, it, expect } from "@effect/vitest";
import dedent from "dedent";
import { Duration, Effect, Layer, Option, TestClock } from "effect";

import { StreamPath } from "./domain.js";
import { ConfigSetEvent, DeveloperMessageEvent, UserMessageEvent } from "./events.js";
import { makeTestEventStream, TestLanguageModel } from "./testing/index.js";
import { ClockProcessor } from "./processors/clock/index.js";
import { TimeTickEvent } from "./processors/clock/events.js";
import {
  CodemodeProcessor,
  codeExecutionRuntimeTest,
  createMockFetch,
  createMockExeca,
  CodeEvalDoneEvent,
  CodeEvalFailedEvent,
  DeferredBlockAddedEvent,
  DeferredCompletedEvent,
  DeferredPollAttemptedEvent,
  ToolRegisteredEvent,
} from "./processors/codemode/index.js";
import {
  LlmLoopProcessor,
  llmDebounce,
  RequestEndedEvent,
  RequestStartedEvent,
  ResponseSseEvent,
  SystemPromptEditEvent,
} from "./processors/llm-loop/index.js";

// -------------------------------------------------------------------------------------
// Test Layer Setup
// -------------------------------------------------------------------------------------

/**
 * Create a combined test layer with all mocked dependencies.
 */
const makeTestLayer = (options?: {
  fetch?: typeof global.fetch;
  execa?: ReturnType<typeof createMockExeca>;
  env?: Record<string, string | undefined>;
}) => {
  const runtimeLayer = codeExecutionRuntimeTest(options ?? {});
  return Layer.merge(TestLanguageModel.layer, runtimeLayer);
};

// -------------------------------------------------------------------------------------
// Integration Tests: LLM → Codemode Flow
// -------------------------------------------------------------------------------------

describe("LLM + Codemode Integration", () => {
  it.scoped("minimal test - just LLM processor", () =>
    Effect.gen(function* () {
      yield* Effect.log("Test started");
      const lm = yield* TestLanguageModel;
      const stream = yield* makeTestEventStream(StreamPath.make("test"));

      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();
      yield* Effect.log("LLM processor started");

      yield* stream.append(UserMessageEvent.make({ content: "Hello" }));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);
      yield* lm.waitForCall();
      yield* Effect.log("LLM call received");

      yield* lm.emit(AiResponse.textDeltaPart({ id: "msg1", delta: "Hi there!" }));
      yield* lm.complete();
      yield* stream.waitForEvent(RequestEndedEvent);
      yield* Effect.log("Request completed");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.scoped("minimal test - LLM + Codemode processors", () =>
    Effect.gen(function* () {
      yield* Effect.log("Test started");
      const lm = yield* TestLanguageModel;
      const stream = yield* makeTestEventStream(StreamPath.make("test"));

      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();
      yield* Effect.log("Both processors started");

      yield* stream.append(UserMessageEvent.make({ content: "Hello" }));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);
      yield* lm.waitForCall();
      yield* Effect.log("LLM call received");

      yield* lm.emit(AiResponse.textDeltaPart({ id: "msg1", delta: "Hi there!" }));
      yield* lm.complete();
      yield* stream.waitForEvent(RequestEndedEvent);
      yield* Effect.log("Request completed");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.scoped("LLM response with codemode block triggers evaluation", () =>
    Effect.gen(function* () {
      yield* Effect.log("Starting test");
      const lm = yield* TestLanguageModel;
      yield* Effect.log("Got TestLanguageModel");
      const stream = yield* makeTestEventStream(StreamPath.make("test"));
      yield* Effect.log("Got TestEventStream");

      // Enable LLM BEFORE starting processors (follows pattern from llm-loop tests)
      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* Effect.log("Appended ConfigSetEvent");

      // Start both processors
      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* Effect.log("Started LlmLoopProcessor");
      yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
      yield* Effect.log("Started CodemodeProcessor");
      yield* stream.waitForSubscribe();
      // Give both processors time to fully initialize (both need to subscribe)
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();
      yield* Effect.log("waitForSubscribe done");

      // Send user message
      yield* stream.append(UserMessageEvent.make({ content: "Calculate 2 + 2" }));
      yield* Effect.log("Appended UserMessageEvent");
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);
      yield* Effect.log("Adjusted TestClock");
      yield* lm.waitForCall();
      yield* Effect.log("LLM call received");

      // Wait for request to start
      yield* stream.waitForEvent(RequestStartedEvent);

      // LLM responds with a codemode block
      yield* lm.emit(
        AiResponse.textDeltaPart({
          id: "msg1",
          delta: dedent`
            I'll calculate that for you:

            <codemode>
            async function codemode() {
              const result = 2 + 2;
              console.log("Calculating:", result);
              return result;
            }
            </codemode>
          `,
        }),
      );
      yield* lm.complete();

      // Wait for request to end (triggers codemode parsing)
      yield* stream.waitForEvent(RequestEndedEvent);
      console.log("RequestEndedEvent received");

      // Debug: check what events were emitted
      const events = yield* stream.getEvents();
      console.log(`Total events: ${events.length}`);
      for (const e of events) {
        console.log(`Event: ${e.type}`);
      }

      // Codemode should evaluate and produce result
      const evalDone = yield* stream.waitForEvent(CodeEvalDoneEvent, { timeout: "1 second" });
      expect(evalDone.payload.data).toBe("4");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.scoped("codemode failure is reported back to LLM", () =>
    Effect.gen(function* () {
      const lm = yield* TestLanguageModel;
      const stream = yield* makeTestEventStream(StreamPath.make("test"));

      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();

      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* stream.append(UserMessageEvent.make({ content: "Do something" }));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);
      yield* lm.waitForCall();

      // LLM responds with buggy code
      yield* lm.emit(
        AiResponse.textDeltaPart({
          id: "msg1",
          delta: dedent`
            <codemode>
            async function codemode() {
              throw new Error("Something went wrong!");
            }
            </codemode>
          `,
        }),
      );
      yield* lm.complete();

      yield* stream.waitForEvent(RequestEndedEvent);

      // Should fail
      const evalFailed = yield* stream.waitForEvent(CodeEvalFailedEvent);
      expect(evalFailed.payload.error).toContain("Something went wrong!");

      // Error should be reported back
      yield* stream.waitForEvent(SystemPromptEditEvent);
      const devMessage = yield* stream.waitForEvent(DeveloperMessageEvent);
      expect(devMessage.payload.content).toContain("Something went wrong!");
    }).pipe(Effect.provide(makeTestLayer({}))),
  );

  it.scoped("codemode can use mocked fetch in tool", () =>
    Effect.gen(function* () {
      const lm = yield* TestLanguageModel;
      const stream = yield* makeTestEventStream(StreamPath.make("test"));

      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();

      // Register a tool that uses fetch
      yield* stream.append(
        ToolRegisteredEvent.make({
          name: "getWeather",
          description: "Get weather for a city",
          parametersJsonSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          returnDescription: Option.some("Weather data"),
          implementation: `
            const res = await fetch(\`https://api.weather.com/\${params.city}\`);
            return await res.json();
          `,
        }),
      );

      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* stream.append(UserMessageEvent.make({ content: "What's the weather in Paris?" }));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);
      yield* lm.waitForCall();

      // LLM uses the tool
      yield* lm.emit(
        AiResponse.textDeltaPart({
          id: "msg1",
          delta: dedent`
            <codemode>
            async function codemode() {
              return await getWeather({ city: "paris" });
            }
            </codemode>
          `,
        }),
      );
      yield* lm.complete();

      yield* stream.waitForEvent(RequestEndedEvent);

      const evalDone = yield* stream.waitForEvent(CodeEvalDoneEvent);
      const result = JSON.parse(evalDone.payload.data as string);
      expect(result).toEqual({ city: "paris", temp: 22, condition: "sunny" });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          fetch: createMockFetch([
            {
              pattern: "api.weather.com",
              response: new Response(
                JSON.stringify({ city: "paris", temp: 22, condition: "sunny" }),
                {
                  headers: { "Content-Type": "application/json" },
                },
              ),
            },
          ]),
        }),
      ),
    ),
  );
});

// -------------------------------------------------------------------------------------
// Integration Tests: LLM → Codemode → Clock (Deferred Blocks)
// -------------------------------------------------------------------------------------

describe("LLM + Codemode + Clock Integration", () => {
  it.scoped("deferred block polls on clock ticks until completion", () => {
    let pollCount = 0;
    const mockFetch = createMockFetch([
      {
        pattern: "api.research.com",
        response: () => {
          pollCount++;
          if (pollCount < 3) {
            return new Response(JSON.stringify({ status: "pending" }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ status: "done", result: "Research complete!" }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    ]);

    return Effect.gen(function* () {
      const lm = yield* TestLanguageModel;
      const stream = yield* makeTestEventStream(StreamPath.make("test"));

      // Start all three processors
      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
      yield* ClockProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();

      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* stream.append(UserMessageEvent.make({ content: "Start a research task" }));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);
      yield* lm.waitForCall();

      // LLM emits a deferred block via codemode
      yield* lm.emit(
        AiResponse.textDeltaPart({
          id: "msg1",
          delta: dedent`
            I'll start a background research task:

            <codemode>
            async function codemode() {
              emit({
                type: "iterate:codemode:deferred-block-added",
                payload: {
                  code: \`
                    async function codemode() {
                      const res = await fetch("https://api.research.com/status");
                      const data = await res.json();
                      if (data.status === "done") return data.result;
                      return null;
                    }
                  \`,
                  checkIntervalSeconds: 10,
                  maxAttempts: 5,
                  description: "Research task",
                },
              });
              return "Research started";
            }
            </codemode>
          `,
        }),
      );
      yield* lm.complete();

      yield* stream.waitForEvent(RequestEndedEvent);

      // Codemode executes and emits the deferred block
      const evalDone = yield* stream.waitForEvent(CodeEvalDoneEvent);
      expect(evalDone.payload.data).toBe('"Research started"');

      const deferredAdded = yield* stream.waitForEvent(DeferredBlockAddedEvent);
      expect(deferredAdded.payload.description).toBe("Research task");

      // Advance clock to trigger time ticks and polling
      // ClockProcessor emits ticks every 10 seconds
      yield* TestClock.adjust(Duration.seconds(10));
      yield* Effect.yieldNow(); // Let clock emit tick

      const tick1 = yield* stream.waitForEvent(TimeTickEvent);
      expect(tick1.payload.elapsedSeconds).toBe(10);

      const poll1 = yield* stream.waitForEvent(DeferredPollAttemptedEvent);
      expect(poll1.payload.attemptNumber).toBe(1);
      expect(poll1.payload.result).toBeNull();

      // Advance again
      yield* TestClock.adjust(Duration.seconds(10));
      yield* Effect.yieldNow();

      const tick2 = yield* stream.waitForEvent(TimeTickEvent);
      expect(tick2.payload.elapsedSeconds).toBe(20);

      const poll2 = yield* stream.waitForEvent(DeferredPollAttemptedEvent);
      expect(poll2.payload.attemptNumber).toBe(2);
      expect(poll2.payload.result).toBeNull();

      // Third tick should complete
      yield* TestClock.adjust(Duration.seconds(10));
      yield* Effect.yieldNow();

      yield* stream.waitForEvent(TimeTickEvent);

      const poll3 = yield* stream.waitForEvent(DeferredPollAttemptedEvent);
      expect(poll3.payload.attemptNumber).toBe(3);
      expect(poll3.payload.result).toBe('"Research complete!"');

      const completed = yield* stream.waitForEvent(DeferredCompletedEvent);
      expect(completed.payload.result).toBe('"Research complete!"');

      // The completion should be reported back as a developer message
      // Skip the status messages for polls 1 and 2
      yield* stream.waitForEventCount(DeveloperMessageEvent, 4); // system prompt + codemode result + 2 status
      const completionMsg = yield* stream.waitForEvent(DeveloperMessageEvent);
      expect(completionMsg.payload.content).toContain("Deferred task completed");
      expect(completionMsg.payload.content).toContain("Research complete!");
    }).pipe(Effect.provide(makeTestLayer({ fetch: mockFetch })));
  });

  it.scoped(
    "full conversation flow: user → LLM → codemode with tool → result → LLM continues",
    () =>
      Effect.gen(function* () {
        const lm = yield* TestLanguageModel;
        const stream = yield* makeTestEventStream(StreamPath.make("test"));

        yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
        yield* CodemodeProcessor.run(stream).pipe(Effect.forkScoped);
        yield* stream.waitForSubscribe();

        // Register a tool
        yield* stream.append(
          ToolRegisteredEvent.make({
            name: "runCommand",
            description: "Run a shell command",
            parametersJsonSchema: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
            returnDescription: Option.none(),
            implementation: `
            const result = await execa(params.cmd, []);
            return result.stdout;
          `,
          }),
        );

        yield* stream.append(ConfigSetEvent.make({ model: "openai" }));

        // User asks to check disk usage
        yield* stream.append(UserMessageEvent.make({ content: "Check disk usage" }));
        yield* Effect.yieldNow();
        yield* TestClock.adjust(llmDebounce.duration);
        yield* lm.waitForCall();

        // LLM runs a command
        yield* lm.emit(
          AiResponse.textDeltaPart({
            id: "msg1",
            delta: dedent`
            <codemode>
            async function codemode() {
              return await runCommand({ cmd: "df" });
            }
            </codemode>
          `,
          }),
        );
        yield* lm.complete();

        yield* stream.waitForEvent(RequestEndedEvent);

        const evalDone = yield* stream.waitForEvent(CodeEvalDoneEvent);
        expect(evalDone.payload.data).toContain("500GB free");

        // Developer message with result triggers new LLM call
        yield* stream.waitForEvent(DeveloperMessageEvent);
        yield* Effect.yieldNow();
        yield* TestClock.adjust(llmDebounce.duration);
        yield* lm.waitForCall();

        // LLM responds to the result
        yield* lm.emit(
          AiResponse.textDeltaPart({
            id: "msg2",
            delta: "You have 500GB free disk space available.",
          }),
        );
        yield* lm.complete();

        yield* stream.waitForEvent(RequestEndedEvent);

        // Verify the conversation flowed correctly
        const events = yield* stream.getEvents();
        const sseEvents = events.filter((e) => ResponseSseEvent.is(e));
        expect(sseEvents.length).toBeGreaterThanOrEqual(2); // At least 2 LLM responses
      }).pipe(
        Effect.provide(
          makeTestLayer({
            execa: createMockExeca([
              {
                command: "df",
                result: { stdout: "Filesystem: 500GB free" },
              },
            ]),
          }),
        ),
      ),
  );
});
