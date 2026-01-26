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
import { Effect, HashSet, Option, Schema, Stream } from "effect";

import { Event, EventInput, Offset } from "../../domain.js";
import { UserMessageEvent } from "../../events.js";
import { Processor, toLayer } from "../processor.js";
import { withSpanFromEvent } from "../../tracing/helpers.js";
import { RequestEndedEvent, ResponseSseEvent, SystemPromptEditEvent } from "../llm-loop/events.js";
import { TimeTickEvent } from "../clock/events.js";
import {
  CodeBlockAddedEvent,
  CodeEvalDoneEvent,
  CodeEvalFailedEvent,
  CodeEvalStartedEvent,
  DeferredBlockAddedEvent,
  DeferredCancelledEvent,
  DeferredCompletedEvent,
  DeferredFailedEvent,
  DeferredPollAttemptedEvent,
  DeferredTimedOutEvent,
  LogEntry,
  RequestId,
  ToolRegisteredEvent,
  ToolUnregisteredEvent,
} from "./events.js";
import { RegisteredTool, fromEventPayload } from "./tools/types.js";
import { generateToolSignature } from "./tools/typescript-gen.js";

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
 * Generate a system prompt section for a registered tool.
 * Includes a TypeScript function signature for better LLM understanding.
 */
const generateToolPrompt = (tool: RegisteredTool): string => {
  const signature = generateToolSignature({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parametersJsonSchema,
    returnDescription: Option.isSome(tool.returnDescription)
      ? tool.returnDescription.value
      : undefined,
  });

  return dedent`
      ## Tool: ${tool.name}

      ${tool.description}

      **TypeScript Signature:**
      \`\`\`typescript
      ${signature}
      \`\`\`

      **Usage:**
      \`\`\`
      <codemode>
      async function codemode() {
        return await ${tool.name}({ /* params */ });
      }
      </codemode>
      \`\`\`
    `;
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

/**
 * Tracks an active deferred block awaiting completion.
 */
class DeferredBlock extends Schema.Class<DeferredBlock>("CodemodeProcessor/DeferredBlock")({
  /** Offset of the DeferredBlockAddedEvent (serves as unique ID) */
  blockOffset: Schema.String,
  /** The code to execute on each poll */
  code: Schema.String,
  /** How often to check, in seconds */
  checkIntervalSeconds: Schema.Number,
  /** Maximum number of poll attempts */
  maxAttempts: Schema.Number,
  /** Human-readable description */
  description: Schema.String,
  /** Number of polls attempted so far */
  attemptCount: Schema.Number,
  /** Last poll time in elapsed seconds (to know when to poll next) */
  lastPollElapsedSeconds: Schema.Number,
}) {}

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
  /** Registered tools (with implementations) */
  registeredTools: Schema.Array(RegisteredTool),
  /** Tool names for which we've emitted system prompt edits */
  toolPromptsEmitted: Schema.HashSet(Schema.String),
  /** Active deferred blocks awaiting completion, keyed by blockOffset */
  deferredBlocks: Schema.Array(DeferredBlock),
  /** Current elapsed seconds from TimeTickEvent (for scheduling deferred polls) */
  currentElapsedSeconds: Schema.Number,
}) {
  static initial = State.make({
    lastOffset: Offset.make("-1"),
    currentAssistantText: "",
    currentRequestOffset: Option.none(),
    processedBlockCount: 0,
    pendingEvaluation: [],
    inProgress: [],
    systemPromptEmitted: false,
    registeredTools: [],
    toolPromptsEmitted: HashSet.empty(),
    deferredBlocks: [],
    currentElapsedSeconds: 0,
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
  /** Emit an event to the stream */
  emit: (event: EventInput) => void;
  /** Registered tools, keyed by name */
  [toolName: string]: unknown;
};

type SuccessResult = {
  success: true;
  data: string;
  logs: Array<LogEntry>;
  emittedEvents: Array<EventInput>;
};
type FailureResult = {
  success: false;
  error: string;
  logs: Array<LogEntry>;
  emittedEvents: Array<EventInput>;
};
type Result = SuccessResult | FailureResult;

/**
 * Context passed to tool implementations.
 * Similar to ExecutionContext but without index signature for cleaner typing.
 */
type ToolContext = {
  console: Console;
  fetch: typeof global.fetch;
  execa: typeof import("execa").execa;
  process: { env: typeof process.env };
  require: typeof global.require;
  /** Emit an event to the stream (for deferred blocks, etc.) */
  emit: (event: { type: string; payload: Record<string, unknown> }) => void;
};

/**
 * Create a tool function factory from a RegisteredTool's implementation string.
 *
 * Returns a function that takes a context (including emit) and returns the actual tool function.
 * This allows us to bind emit at call time rather than at creation time.
 *
 * The implementation string is the body of an async function that receives:
 * - `params` - the validated parameters
 * - `fetch`, `execa`, `console`, `process`, `require`, `emit` from ToolContext
 */
const createToolFunctionFactory = (
  tool: RegisteredTool,
): ((context: ToolContext) => (params: unknown) => Promise<unknown>) => {
  // Build a function that wraps the implementation string
  // The implementation has access to: params, fetch, execa, console, process, require, emit
  const wrappedCode = `
    return async function ${tool.name}(params, context) {
      const { fetch, execa, console, process, require, emit } = context;
      ${tool.implementation}
    };
  `;

  try {
    const fn = new Function(wrappedCode)();
    return (context: ToolContext) => async (params: unknown) => {
      // TODO: Validate params against parametersJsonSchema here
      return fn(params, context);
    };
  } catch (error) {
    // If the implementation is invalid, return a function that throws
    const errorMessage = error instanceof Error ? error.message : String(error);
    return () => async () => {
      throw new Error(`Tool "${tool.name}" has invalid implementation: ${errorMessage}`);
    };
  }
};

/**
 * Build a map of tool function factories from registered tools.
 *
 * Returns factories that need to be bound with a context (including emit) at call time.
 */
const buildToolFactories = (
  registeredTools: ReadonlyArray<RegisteredTool>,
): ReadonlyMap<string, (context: ToolContext) => (params: unknown) => Promise<unknown>> => {
  const factories = new Map<
    string,
    (context: ToolContext) => (params: unknown) => Promise<unknown>
  >();

  for (const tool of registeredTools) {
    factories.set(tool.name, createToolFunctionFactory(tool));
  }

  return factories;
};

/**
 * Execute code and capture console.log calls.
 * Code must define `async function codemode() { ... }`.
 *
 * @param code - The code to execute
 * @param toolFactories - Map of tool name to tool function factory
 */
const executeCode = async (
  code: string,
  toolFactories: ReadonlyMap<
    string,
    (context: ToolContext) => (params: unknown) => Promise<unknown>
  >,
): Promise<Result> => {
  const logs: Array<LogEntry> = [];
  const emittedEvents: Array<EventInput> = [];

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

  // Create emit function that collects events (used by codemode and tools)
  const emit = (event: { type: string; payload: Record<string, unknown> }): void => {
    // Convert plain object to EventInput-like shape
    emittedEvents.push(EventInput.make({ type: event.type as never, payload: event.payload }));
  };

  // Tool context for binding tools
  const toolContext: ToolContext = {
    console: capturedConsole as Console,
    fetch: global.fetch,
    execa: execa,
    process: { env: process.env },
    require: global.require,
    emit,
  };

  try {
    // Build the parameter list for the wrapper function
    const toolNames = Array.from(toolFactories.keys());
    const baseParams = ["console", "fetch", "execa", "process", "require", "emit"];
    const allParams = [...baseParams, ...toolNames];

    // Wrap the code to inject our console, tools, and extract the function
    const wrappedCode = `
      return (async ({${allParams.join(", ")}}) => {
        ${code}
        if (typeof codemode !== 'function') {
          throw new Error('Code must define an async function named "codemode"');
        }
        return await codemode();
      });
    `;

    const factory = new Function(wrappedCode)();

    // Build the context object with base context + bound tools
    const context: ExecutionContext = {
      console: capturedConsole as Console,
      fetch: global.fetch,
      execa: execa,
      process: { env: process.env },
      require: global.require,
      emit,
    };

    // Bind each tool factory with the tool context and add to execution context
    for (const [name, toolFactory] of toolFactories) {
      context[name] = toolFactory(toolContext);
    }

    const result = await factory(context);

    // Try to serialize the result
    try {
      const serialized = JSON.stringify(result);
      return { success: true, data: serialized, logs, emittedEvents };
    } catch {
      return {
        success: true,
        data: JSON.stringify("[non-serializable result]"),
        logs,
        emittedEvents,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage, logs, emittedEvents };
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

  // Track tool system prompt edits (for replay)
  if (
    SystemPromptEditEvent.is(event) &&
    Option.isSome(event.payload.source) &&
    event.payload.source.value.startsWith("codemode:tool:")
  ) {
    const toolName = event.payload.source.value.replace("codemode:tool:", "");
    return State.make({
      ...base,
      toolPromptsEmitted: HashSet.add(state.toolPromptsEmitted, toolName),
    });
  }

  // Handle tool registration - store the full tool including implementation
  if (ToolRegisteredEvent.is(event)) {
    const tool = fromEventPayload(event.payload);
    // Replace existing tool with same name or add new
    const existingIndex = state.registeredTools.findIndex((t) => t.name === event.payload.name);
    const newTools =
      existingIndex >= 0
        ? [
            ...state.registeredTools.slice(0, existingIndex),
            tool,
            ...state.registeredTools.slice(existingIndex + 1),
          ]
        : [...state.registeredTools, tool];
    return State.make({
      ...base,
      registeredTools: newTools,
    });
  }

  // Handle tool unregistration
  if (ToolUnregisteredEvent.is(event)) {
    return State.make({
      ...base,
      registeredTools: state.registeredTools.filter((t) => t.name !== event.payload.name),
      toolPromptsEmitted: HashSet.remove(state.toolPromptsEmitted, event.payload.name),
    });
  }

  // Track time ticks for deferred block scheduling
  if (TimeTickEvent.is(event)) {
    return State.make({
      ...base,
      currentElapsedSeconds: event.payload.elapsedSeconds,
    });
  }

  // Track deferred block registration
  if (DeferredBlockAddedEvent.is(event)) {
    const newBlock = DeferredBlock.make({
      blockOffset: event.offset,
      code: event.payload.code,
      checkIntervalSeconds: event.payload.checkIntervalSeconds,
      maxAttempts: event.payload.maxAttempts,
      description: event.payload.description,
      attemptCount: 0,
      lastPollElapsedSeconds: state.currentElapsedSeconds, // Start from current time
    });
    return State.make({
      ...base,
      deferredBlocks: [...state.deferredBlocks, newBlock],
    });
  }

  // Track deferred poll attempts (update attempt count and last poll time)
  if (DeferredPollAttemptedEvent.is(event)) {
    return State.make({
      ...base,
      deferredBlocks: state.deferredBlocks.map((block) =>
        block.blockOffset === event.payload.blockOffset
          ? DeferredBlock.make({
              ...block,
              attemptCount: event.payload.attemptNumber,
              lastPollElapsedSeconds: event.payload.elapsedSeconds,
            })
          : block,
      ),
    });
  }

  // Remove deferred blocks on completion, failure, timeout, or cancellation
  if (
    DeferredCompletedEvent.is(event) ||
    DeferredFailedEvent.is(event) ||
    DeferredTimedOutEvent.is(event) ||
    DeferredCancelledEvent.is(event)
  ) {
    return State.make({
      ...base,
      deferredBlocks: state.deferredBlocks.filter(
        (block) => block.blockOffset !== event.payload.blockOffset,
      ),
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
        `hydrated, lastOffset=${state.lastOffset}, pending=${state.pendingEvaluation.length}, inProgress=${state.inProgress.length}, tools=${state.registeredTools.length}`,
      );

      // Phase 2: Subscribe to live events
      yield* stream.subscribe({ from: state.lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const prevState = state;
            state = reduce(state, event);

            // Emit system prompt on first event if not yet emitted
            if (!state.systemPromptEmitted) {
              yield* Effect.gen(function* () {
                yield* Effect.log("emitting codemode system prompt");
                yield* stream.append(
                  SystemPromptEditEvent.make({
                    mode: "append",
                    content: CODEMODE_SYSTEM_PROMPT,
                    source: Option.some("codemode"),
                  }),
                );
              }).pipe(withSpanFromEvent("codemode.emit-system-prompt", event));
              // Mark as emitted locally (reducer will also see our event on replay)
              state = State.make({ ...state, systemPromptEmitted: true });
            }

            // When a tool is registered, emit its system prompt
            if (ToolRegisteredEvent.is(event)) {
              const toolName = event.payload.name;
              if (!HashSet.has(state.toolPromptsEmitted, toolName)) {
                const tool = state.registeredTools.find((t) => t.name === toolName);
                if (tool) {
                  yield* Effect.log(`emitting system prompt for tool: ${toolName}`).pipe(
                    withSpanFromEvent("codemode.emit-tool-prompt", event),
                  );
                  const promptContent = generateToolPrompt(tool);
                  yield* stream.append(
                    SystemPromptEditEvent.make({
                      mode: "append",
                      content: promptContent,
                      source: Option.some(`codemode:tool:${toolName}`),
                    }),
                  );
                }
                // Mark as emitted locally
                state = State.make({
                  ...state,
                  toolPromptsEmitted: HashSet.add(state.toolPromptsEmitted, toolName),
                });
              }
            }

            // When an LLM request ends, parse for codemode blocks
            if (RequestEndedEvent.is(event)) {
              const blocks = extractCodemodeBlocks(prevState.currentAssistantText);
              const newBlocks = blocks.slice(prevState.processedBlockCount);

              if (newBlocks.length > 0) {
                yield* Effect.gen(function* () {
                  yield* Effect.log(`found ${newBlocks.length} new codemode blocks`);
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
                }).pipe(withSpanFromEvent("codemode.detect-blocks", event));
              }
            }

            // When a code block is added, evaluate it
            if (CodeBlockAddedEvent.is(event)) {
              yield* Effect.gen(function* () {
                const { requestId, code } = event.payload;

                // Annotate span with request context
                yield* Effect.annotateCurrentSpan("request.id", requestId);

                yield* Effect.log(`evaluating code block ${requestId}`);
                yield* stream.append(CodeEvalStartedEvent.make({ requestId }));

                // Build the tool factories from registered tools
                const toolFactories = buildToolFactories(state.registeredTools);

                // Run the evaluation (this is async/Promise-based)
                const result = yield* Effect.promise(() => executeCode(code, toolFactories));

                // Append any events emitted by the code
                if (result.emittedEvents.length > 0) {
                  yield* Effect.log(`appending ${result.emittedEvents.length} emitted events`);
                  for (const emittedEvent of result.emittedEvents) {
                    yield* stream.append(emittedEvent);
                  }
                }

                // Annotate span with result
                yield* Effect.annotateCurrentSpan("eval.success", result.success);
                if (!result.success) {
                  yield* Effect.annotateCurrentSpan("eval.error", result.error);
                  yield* Effect.annotateCurrentSpan("error", true);
                }

                if (result.success) {
                  yield* stream.append(CodeEvalDoneEvent.make({ requestId, ...result }));
                  yield* Effect.log(`code block ${requestId} completed successfully`);

                  // Append a synthetic user message to inform the LLM of the result
                  const summary = createResultSummary(result);
                  yield* Effect.log(`appending codemode result (${summary.length} chars)`);
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

                  // Append a synthetic user message to inform the LLM of the failure
                  const summary = createResultSummary(result);
                  yield* Effect.log(`appending codemode error result (${summary.length} chars)`);
                  yield* stream.append(UserMessageEvent.make({ content: summary }));
                }
              }).pipe(withSpanFromEvent("codemode.eval", event));
            }

            // When a time tick arrives, check if any deferred blocks need polling
            if (TimeTickEvent.is(event)) {
              const elapsedSeconds = event.payload.elapsedSeconds;

              // Find blocks that are due for polling
              const blocksToPoll = state.deferredBlocks.filter((block) => {
                const timeSinceLastPoll = elapsedSeconds - block.lastPollElapsedSeconds;
                return timeSinceLastPoll >= block.checkIntervalSeconds;
              });

              if (blocksToPoll.length > 0) {
                yield* Effect.log(
                  `time tick at ${elapsedSeconds}s, polling ${blocksToPoll.length} deferred blocks`,
                );
              }

              for (const block of blocksToPoll) {
                yield* Effect.gen(function* () {
                  const attemptNumber = block.attemptCount + 1;
                  yield* Effect.log(
                    `polling deferred block ${block.blockOffset} (attempt ${attemptNumber}/${block.maxAttempts}): ${block.description}`,
                  );

                  // Build the tool factories
                  const toolFactories = buildToolFactories(state.registeredTools);

                  // Execute the deferred block code
                  const result = yield* Effect.promise(() =>
                    executeCode(block.code, toolFactories),
                  );

                  // Append any events emitted by the code
                  if (result.emittedEvents.length > 0) {
                    yield* Effect.log(
                      `deferred block emitted ${result.emittedEvents.length} events`,
                    );
                    for (const emittedEvent of result.emittedEvents) {
                      yield* stream.append(emittedEvent);
                    }
                  }

                  if (!result.success) {
                    // Code threw an error - deferred block failed
                    yield* Effect.log(
                      `deferred block ${block.blockOffset} failed: ${result.error}`,
                    );
                    yield* stream.append(
                      DeferredPollAttemptedEvent.make({
                        blockOffset: block.blockOffset,
                        attemptNumber,
                        elapsedSeconds,
                        result: null,
                        logs: [...result.logs],
                      }),
                    );
                    yield* stream.append(
                      DeferredFailedEvent.make({
                        blockOffset: block.blockOffset,
                        error: result.error,
                      }),
                    );
                    // Notify LLM of failure
                    yield* stream.append(
                      UserMessageEvent.make({
                        content: dedent`
                          <developer-message>
                            [Deferred task failed]

                            Task: ${block.description}
                            Error: ${result.error}

                            Console logs:
                            ${formatLogs([...result.logs])}
                          </developer-message>
                        `,
                      }),
                    );
                    return;
                  }

                  // Check if result is truthy (task complete) or falsy (keep polling)
                  const parsedResult = JSON.parse(result.data);
                  const isComplete = Boolean(parsedResult);

                  yield* stream.append(
                    DeferredPollAttemptedEvent.make({
                      blockOffset: block.blockOffset,
                      attemptNumber,
                      elapsedSeconds,
                      result: isComplete ? result.data : null,
                      logs: [...result.logs],
                    }),
                  );

                  if (isComplete) {
                    // Task completed successfully
                    yield* Effect.log(`deferred block ${block.blockOffset} completed`);
                    yield* stream.append(
                      DeferredCompletedEvent.make({
                        blockOffset: block.blockOffset,
                        result: result.data,
                      }),
                    );
                    // Notify LLM of completion
                    yield* stream.append(
                      UserMessageEvent.make({
                        content: dedent`
                          <developer-message>
                            [Deferred task completed]

                            Task: ${block.description}
                            Result: ${result.data}

                            Console logs:
                            ${formatLogs([...result.logs])}
                          </developer-message>
                        `,
                      }),
                    );
                  } else if (attemptNumber >= block.maxAttempts) {
                    // Timed out - exceeded max attempts
                    yield* Effect.log(
                      `deferred block ${block.blockOffset} timed out after ${attemptNumber} attempts`,
                    );
                    yield* stream.append(
                      DeferredTimedOutEvent.make({
                        blockOffset: block.blockOffset,
                        attempts: attemptNumber,
                      }),
                    );
                    // Notify LLM of timeout
                    yield* stream.append(
                      UserMessageEvent.make({
                        content: dedent`
                          <developer-message>
                            [Deferred task timed out]

                            Task: ${block.description}
                            Attempts: ${attemptNumber}

                            The task did not complete within the maximum number of polling attempts.
                          </developer-message>
                        `,
                      }),
                    );
                  } else {
                    // Still pending - keep polling
                    yield* Effect.log(
                      `deferred block ${block.blockOffset} still pending (attempt ${attemptNumber}/${block.maxAttempts})`,
                    );
                    // Notify LLM of pending status so it can decide whether to acknowledge
                    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
                    const elapsedSecondsRemainder = elapsedSeconds % 60;
                    const elapsedStr =
                      elapsedMinutes > 0
                        ? `${elapsedMinutes}m ${elapsedSecondsRemainder}s`
                        : `${elapsedSeconds}s`;
                    yield* stream.append(
                      UserMessageEvent.make({
                        content: dedent`
                          <developer-message>
                            [Background task still in progress]

                            Task: ${block.description}
                            Status: Polling attempt ${attemptNumber}/${block.maxAttempts} (~${elapsedStr} elapsed)

                            This is an automatic status update. The system is already polling for completion - do NOT use codemode or call any tools in response to this message. Simply acknowledge the wait to the user if you haven't recently, or say nothing if you already have.
                          </developer-message>
                        `,
                      }),
                    );
                  }
                }).pipe(withSpanFromEvent(`codemode.deferred-poll.${block.blockOffset}`, event));
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
