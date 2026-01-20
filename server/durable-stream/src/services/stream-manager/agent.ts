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

const DEFAULT_MODEL: AiModelType = "openai";

// -------------------------------------------------------------------------------------
// Agent Layer
// -------------------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const inner = yield* StreamManager;
  const aiClient = yield* AiClient;

  // Per-path model selection (defaults to openai)
  const modelByPath = new Map<StreamPath, AiModelType>();

  /** Apply config change event to path state. Returns true if config changed. */
  const applyConfig = (path: StreamPath, event: EventInput): boolean => {
    const configChange = AiModelType.fromEventInput(event);
    if (Option.isSome(configChange)) {
      modelByPath.set(path, configChange.value);
      return true;
    }
    return false;
  };

  /** Get model for path, warming up on first access. */
  const getModel = (path: StreamPath) =>
    Effect.gen(function* () {
      if (!modelByPath.has(path)) {
        yield* Effect.log(`Warming up config for path: ${path}`);
        yield* inner
          .subscribe({ path, live: false })
          .pipe(Stream.runForEach((event) => Effect.sync(() => applyConfig(path, event))));
        if (!modelByPath.has(path)) {
          modelByPath.set(path, DEFAULT_MODEL);
        }
        yield* Effect.log(`Warmup complete for path: ${path}`);
      }
      return modelByPath.get(path) ?? DEFAULT_MODEL;
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
        yield* Effect.log(`Triggering ${model} AI generation...`);
        yield* aiClient
          .prompt(model, input.path, promptInput.value)
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
