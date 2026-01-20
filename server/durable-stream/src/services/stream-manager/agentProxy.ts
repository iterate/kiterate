/**
 * Agent layer for StreamManager - adds LLM integration
 *
 * Wraps an underlying StreamManager to:
 * - Detect user messages and trigger LLM generation
 * - Append LLM response events to the stream
 */
import { Effect, Layer, Option, Stream } from "effect";

import { EventInput, type Offset, type StreamPath } from "../../domain.js";
import { AiClient, AiModelType, PromptInput } from "../ai-client/index.js";
import { StreamManager } from "./service.js";

// -------------------------------------------------------------------------------------
// Agent Layer
// -------------------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const inner = yield* StreamManager;
  const aiClient = yield* AiClient;

  // Per-path model selection: None = warmed up but not configured, Some = configured
  const modelByPath = new Map<StreamPath, Option.Option<AiModelType>>();

  /** Apply config change event to path state */
  const applyConfig = (path: StreamPath, event: EventInput): boolean => {
    const configChange = AiModelType.fromEventInput(event);
    if (Option.isSome(configChange)) {
      modelByPath.set(path, Option.some(configChange.value));
      return true;
    }
    return false;
  };

  /** Get model for path, warming up on first access. Returns None if not configured. */
  const getModel = (path: StreamPath) =>
    Effect.gen(function* () {
      if (!modelByPath.has(path)) {
        yield* Effect.log(`Warming up config for path: ${path}`);
        yield* inner
          .subscribe({ path, live: false })
          .pipe(Stream.runForEach((event) => Effect.sync(() => applyConfig(path, event))));
        if (!modelByPath.has(path)) {
          modelByPath.set(path, Option.none());
        }
        yield* Effect.log(`Warmup complete for path: ${path}`);
      }
      return modelByPath.get(path)!;
    });

  const subscribe = (input: { path: StreamPath; after?: Offset; live?: boolean }) =>
    inner.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* Effect.log(`AgentManager.append: type=${input.event.type}`);
      yield* inner.append(input);

      if (applyConfig(input.path, input.event)) {
        yield* Effect.log(`Switched AI model`);
        return;
      }

      const promptInput = PromptInput.fromEventInput(input.event);
      if (Option.isSome(promptInput)) {
        const model = yield* getModel(input.path);
        if (Option.isNone(model)) {
          yield* Effect.log(`No AI model configured for path, skipping generation`);
          return;
        }
        yield* Effect.log(`Triggering ${model.value} AI generation...`);
        yield* aiClient
          .prompt(model.value, input.path, promptInput.value)
          .pipe(Stream.runForEach((event) => inner.append({ path: input.path, event })));
      }
    });

  return StreamManager.of({ subscribe, append });
});

export const agentLayer = Layer.effect(StreamManager, make);

// -------------------------------------------------------------------------------------
// Test layer - no LLM, just logs and delegates
// -------------------------------------------------------------------------------------

const makeTest = Effect.gen(function* () {
  const inner = yield* StreamManager;

  const subscribe = (input: { path: StreamPath; after?: Offset; live?: boolean }) =>
    inner.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* Effect.log(`AgentManager(test).append: type=${input.event.type} [LLM disabled]`);
      yield* inner.append(input);
    });

  return StreamManager.of({ subscribe, append });
});

/** Test layer - no LLM integration, just logs and delegates */
export const testLayer: Layer.Layer<StreamManager, never, StreamManager> = Layer.effect(
  StreamManager,
  makeTest,
);
