import { execa } from "execa";
/**
 * Codemode Processor
 *
 * Parses assistant messages for <codemode>...</codemode> blocks,
 * evaluates the contained JavaScript code, and emits lifecycle events.
 *
 * The code inside <codemode> tags must be an async function named `codemode`:
 * ```
 * <codemode>
 * async function codemode() {
 *   // your code here
 *   return someValue;
 * }
 * </codemode>
 * ```
 */
import dedent from "dedent";
import { Effect, Option, Schema, Stream } from "effect";

import { Event, Offset } from "../../domain.js";
import { UserMessageEvent } from "../../events.js";
import { Processor, toLayer } from "../processor.js";
import { RequestEndedEvent, ResponseSseEvent, SystemPromptEditEvent } from "../llm-loop/events.js";
import {
  CodeBlockAddedEvent,
  CodeEvalDoneEvent,
  CodeEvalFailedEvent,
  CodeEvalStartedEvent,
  LogEntry,
  RequestId,
} from "./events.js";

// -------------------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------------------

const CODEMODE_OPEN_TAG = "<codemode>";
const CODEMODE_CLOSE_TAG = "</codemode>";

/** System prompt instructions for codemode */
const CODEMODE_SYSTEM_PROMPT = dedent`
  You are a helpful assistant that helps users with arbitrary tasks by running JavaScript code. If you don't know how to do something, you will generate a "codemode" script which will then be executed in a secure, sandboxed environment. You can use fetch, execute shell commands, and access environment variables, so there's very little you *can't* do.

  You run JavaScript code by writing a no-args async function called \`codemode\` and surrounding it with XML blocks like this:

  <codemode>
  async function codemode() {
    console.log("I can do whatever here!")
    const res = await fetch("https://example.com")
    return { exampleDotComIsUp: res.ok }
  }
  </codemode>

  You can also use the \`execa\` function to execute shell commands. For example, to list the files in the current directory, you can do this:
  <codemode>
  async function codemode() {
    return await execa("ls", ["-l"]);
  }
  </codemode>

  This will return the output of the \`ls\` command as a formatted string.

  The code will be evaluated and the result (or error) will be returned to you in a follow-up message.
  You can access environment variables via \`process.env\`. If you want to check which are available, run \`console.log(Object.keys(process.env))\`.

  For example, if they ask you to use discord and you need a token, you could do this to find a suitable environment variable:

  <codemode>
  async function codemode() {
    return Object.keys(process.env).filter(k => k.match(/DISCORD/i));
  }
  </codemode>

  The following global variables are available for use in your code:

  - \`console\`: The console object (with log, error, warn, info, and debug methods)
  - \`fetch\`: The fetch function
  - \`execa\`: The execa function for running shell commands (usage docs: https://www.npmjs.com/package/execa)
  - \`process.env\`: The environment variables
  - \`import\`: The import function for loading external modules (e.g. \`const fs = await import("fs")\`)

  Use codemode when you need to fetch data, perform calculations, or interact with external services.
`;

/**
 * Format logs for display in the summary message.
 */
const formatLogs = (logs: Array<LogEntry>): string => {
  if (logs.length === 0) return "No console output.";
  return logs
    .map((log) => {
      const argsStr = log.args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      return `[${new Date(log.timestamp).toLocaleTimeString()}] ${argsStr}`;
    })
    .join("\n");
};

/**
 * Create a summary message for the LLM after code evaluation.
 */
const createResultSummary = (result: Result): string => {
  const logsSection = result.logs.length > 0 ? `\n\nConsole logs:\n${formatLogs(result.logs)}` : "";

  if (result.success) {
    return dedent`
      [Codemode execution completed successfully]

      Output: ${result.data ?? "undefined"}${logsSection}

      Please let the user know how it went. If you think it might be useful to generate a new codemode block, do so.
    `;
  } else {
    return dedent`
      [Codemode execution failed]

      Error: ${result.error ?? "Unknown error"}${logsSection}

      Please let the user know what went wrong and try again if appropriate.
    `;
  }
};

// -------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------

class State extends Schema.Class<State>("CodemodeProcessor/State")({
  lastOffset: Offset,
  /** Accumulated assistant message text from the current LLM request */
  currentAssistantText: Schema.String,
  /** Offset of the current LLM request (from RequestStartedEvent via ResponseSseEvent.requestOffset) */
  currentRequestOffset: Schema.Option(Offset),
  /** Number of codemode blocks already processed for the current request */
  processedBlockCount: Schema.Number,
  /** Request IDs that have been added but not yet started evaluation */
  pendingEvaluation: Schema.Array(RequestId),
  /** Request IDs currently being evaluated */
  inProgress: Schema.Array(RequestId),
  /** Whether we've emitted the system prompt edit */
  systemPromptEmitted: Schema.Boolean,
}) {
  static initial = State.make({
    lastOffset: Offset.make("-1"),
    currentAssistantText: "",
    currentRequestOffset: Option.none(),
    processedBlockCount: 0,
    pendingEvaluation: [],
    inProgress: [],
    systemPromptEmitted: false,
  });
}

// -------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------

/**
 * Extract all complete <codemode>...</codemode> blocks from text.
 * Returns array of { code, startIndex, endIndex }.
 */
const extractCodemodeBlocks = (
  text: string,
): Array<{ code: string; startIndex: number; endIndex: number }> => {
  const blocks: Array<{ code: string; startIndex: number; endIndex: number }> = [];
  let searchStart = 0;

  while (true) {
    const openIndex = text.indexOf(CODEMODE_OPEN_TAG, searchStart);
    if (openIndex === -1) break;

    const closeIndex = text.indexOf(CODEMODE_CLOSE_TAG, openIndex + CODEMODE_OPEN_TAG.length);
    if (closeIndex === -1) break;

    const code = text.slice(openIndex + CODEMODE_OPEN_TAG.length, closeIndex);
    blocks.push({
      code: code.trim(),
      startIndex: openIndex,
      endIndex: closeIndex + CODEMODE_CLOSE_TAG.length,
    });

    searchStart = closeIndex + CODEMODE_CLOSE_TAG.length;
  }

  return blocks;
};

type ExecutionContext = {
  console: Console;
  fetch: typeof global.fetch;
  execa: typeof import("execa").execa;
  process: { env: typeof process.env };
  require: typeof global.require;
};

type SuccessResult = { success: true; data: string; logs: Array<LogEntry> };
type FailureResult = { success: false; error: string; logs: Array<LogEntry> };
type Result = SuccessResult | FailureResult;

/**
 * Execute code and capture console.log calls.
 * Code must define `async function codemode() { ... }`.
 */
const executeCode = async (code: string): Promise<Result> => {
  const logs: Array<LogEntry> = [];

  const logger =
    (level: LogEntry["level"]) =>
    (...args: unknown[]) => {
      logs.push({ level, args, timestamp: new Date().toISOString() });
    };
  // Create a custom console that captures logs
  const capturedConsole = {
    log: logger("info"),
    error: logger("error"),
    warn: logger("warn"),
    info: logger("info"),
    debug: logger("debug"),
  };

  try {
    // Wrap the code to inject our console and extract the function
    const wrappedCode = `
      return (async ({console, fetch, execa, process, require}) => {
        ${code}
        if (typeof codemode !== 'function') {
          throw new Error('Code must define an async function named "codemode"');
        }
        return await codemode();
      });
    `;

    const factory = new Function(wrappedCode)();
    const result = await factory({
      console: capturedConsole as Console,
      fetch: global.fetch,
      execa: execa,
      process: { env: process.env },
      require: global.require,
    } satisfies ExecutionContext);

    // Try to serialize the result
    try {
      const serialized = JSON.stringify(result);
      return { success: true, data: serialized, logs };
    } catch {
      return { success: true, data: JSON.stringify("[non-serializable result]"), logs };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage, logs };
  }
};

// -------------------------------------------------------------------------------------
// Reducer
// -------------------------------------------------------------------------------------

const reduce = (state: State, event: Event): State => {
  const base = { ...state, lastOffset: event.offset };

  // Accumulate assistant response text from SSE events
  if (ResponseSseEvent.is(event)) {
    const textDelta = ResponseSseEvent.decodeTextDelta(event.payload.part);
    if (Option.isSome(textDelta)) {
      // If this is a new request, reset the accumulated text
      const isNewRequest =
        Option.isNone(state.currentRequestOffset) ||
        state.currentRequestOffset.value !== event.payload.requestOffset;

      return State.make({
        ...base,
        currentAssistantText: isNewRequest
          ? textDelta.value.delta
          : state.currentAssistantText + textDelta.value.delta,
        currentRequestOffset: Option.some(event.payload.requestOffset),
        processedBlockCount: isNewRequest ? 0 : state.processedBlockCount,
      });
    }
    return State.make(base);
  }

  // Reset on request end
  if (RequestEndedEvent.is(event)) {
    return State.make({
      ...base,
      currentAssistantText: "",
      currentRequestOffset: Option.none(),
      processedBlockCount: 0,
    });
  }

  // Track code blocks added (for replay)
  if (CodeBlockAddedEvent.is(event)) {
    return State.make({
      ...base,
      pendingEvaluation: [...state.pendingEvaluation, event.payload.requestId],
      processedBlockCount: state.processedBlockCount + 1,
    });
  }

  // Track eval started (for replay)
  if (CodeEvalStartedEvent.is(event)) {
    return State.make({
      ...base,
      pendingEvaluation: state.pendingEvaluation.filter((id) => id !== event.payload.requestId),
      inProgress: [...state.inProgress, event.payload.requestId],
    });
  }

  // Track eval done/failed (for replay)
  if (CodeEvalDoneEvent.is(event) || CodeEvalFailedEvent.is(event)) {
    return State.make({
      ...base,
      inProgress: state.inProgress.filter((id) => id !== event.payload.requestId),
    });
  }

  // Track our own system prompt edit (for replay)
  if (
    SystemPromptEditEvent.is(event) &&
    Option.isSome(event.payload.source) &&
    event.payload.source.value === "codemode"
  ) {
    return State.make({
      ...base,
      systemPromptEmitted: true,
    });
  }

  return State.make(base);
};

// -------------------------------------------------------------------------------------
// Processor
// -------------------------------------------------------------------------------------

export const CodemodeProcessor: Processor<never> = {
  name: "codemode",

  run: (stream) =>
    Effect.gen(function* () {
      // Phase 1: Hydrate from history
      let state = yield* stream.read().pipe(Stream.runFold(State.initial, reduce));

      yield* Effect.log(
        `hydrated, lastOffset=${state.lastOffset}, pending=${state.pendingEvaluation.length}, inProgress=${state.inProgress.length}`,
      );

      // Phase 2: Subscribe to live events
      yield* stream.subscribe({ from: state.lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const prevState = state;
            state = reduce(state, event);

            // Emit system prompt on every event if not yet emitted
            if (!state.systemPromptEmitted) {
              yield* stream.append(
                SystemPromptEditEvent.make({
                  mode: "append",
                  content: CODEMODE_SYSTEM_PROMPT,
                  source: Option.some("codemode"),
                }),
              );
            }

            // When an LLM request ends, parse for codemode blocks
            if (RequestEndedEvent.is(event)) {
              const blocks = extractCodemodeBlocks(prevState.currentAssistantText);
              const newBlocks = blocks.slice(prevState.processedBlockCount);

              if (newBlocks.length > 0) {
                yield* Effect.log(`found ${newBlocks.length} new codemode blocks`);
              }

              for (let i = 0; i < newBlocks.length; i++) {
                const block = newBlocks[i]!;
                const blockIndex = prevState.processedBlockCount + i;
                const requestId = RequestId.make(
                  `${Option.getOrElse(prevState.currentRequestOffset, () => event.offset)}.${blockIndex}`,
                );

                yield* stream.append(
                  CodeBlockAddedEvent.make({
                    requestId,
                    code: block.code,
                  }),
                );
              }
            }

            // When a code block is added, evaluate it
            if (CodeBlockAddedEvent.is(event)) {
              const { requestId, code } = event.payload;

              yield* Effect.log(`evaluating code block ${requestId}`);
              yield* stream.append(CodeEvalStartedEvent.make({ requestId }));

              // Run the evaluation (this is async/Promise-based)
              const result = yield* Effect.promise(() => executeCode(code));

              if (result.success) {
                yield* stream.append(CodeEvalDoneEvent.make({ requestId, ...result }));
                yield* Effect.log(`code block ${requestId} completed successfully`);

                // Append a fake user message to inform the LLM of the result
                const summary = createResultSummary(result);
                yield* stream.append(
                  UserMessageEvent.make({
                    content: dedent`
                    <developer-message>
                      ${summary}
                    </developer-message>
                  `,
                  }),
                );
              } else {
                yield* stream.append(CodeEvalFailedEvent.make({ requestId, ...result }));
                yield* Effect.log(`code block ${requestId} failed: ${result.error}`);

                // Append a fake user message to inform the LLM of the failure
                const summary = createResultSummary(result);
                yield* stream.append(UserMessageEvent.make({ content: summary }));
              }
            }
          }),
        ),
      );
    }),
};

// -------------------------------------------------------------------------------------
// Layer
// -------------------------------------------------------------------------------------

export const CodemodeProcessorLayer = toLayer(CodemodeProcessor);
