/**
 * TestLanguageModel - a mock LanguageModel for testing
 *
 * Provides both the LanguageModel.LanguageModel service and test control methods
 * (emit, complete, fail, waitForCall) under a single Context.Tag.
 */
import { LanguageModel, Response } from "@effect/ai";
import { Context, Deferred, Effect, Layer, Queue, Stream } from "effect";

type StreamPart = Response.StreamPart<{}>;

export interface TestLanguageModelService extends LanguageModel.Service {
  /** Emit a stream part to the current LLM call */
  readonly emit: (part: StreamPart) => Effect.Effect<void>;
  /** Complete the current LLM stream successfully */
  readonly complete: () => Effect.Effect<void>;
  /** Fail the current LLM stream with an error */
  readonly fail: (error: Error) => Effect.Effect<void>;
  /** Wait for the next LLM call to be made */
  readonly waitForCall: () => Effect.Effect<void>;
}

export class TestLanguageModel extends Context.Tag("TestLanguageModel")<
  TestLanguageModel,
  TestLanguageModelService
>() {
  static readonly layer: Layer.Layer<TestLanguageModel | LanguageModel.LanguageModel> =
    Layer.scopedContext(
      Effect.gen(function* () {
        // Mutable state - using let since we're in a closure
        let callCount = 0;
        const callWaiters: Deferred.Deferred<void>[] = [];
        let currentQueue: Queue.Queue<StreamPart> | null = null;
        let currentCompletion: Deferred.Deferred<void> | null = null;

        const service: TestLanguageModelService = {
          // Test control methods
          emit: (part) => (currentQueue ? Queue.offer(currentQueue, part) : Effect.void),
          complete: () =>
            currentCompletion ? Deferred.succeed(currentCompletion, void 0) : Effect.void,
          fail: (_error) =>
            currentCompletion ? Deferred.succeed(currentCompletion, void 0) : Effect.void, // TODO: proper stream failure
          waitForCall: () =>
            Effect.gen(function* () {
              // If we've already had more calls than waiters, return immediately
              if (callCount > callWaiters.length) return;
              // Otherwise create a waiter for the next call
              const deferred = yield* Deferred.make<void>();
              callWaiters.push(deferred);
              yield* Deferred.await(deferred);
            }),

          // LanguageModel.Service implementation
          streamText: () =>
            Effect.gen(function* () {
              // Set up fresh queue and completion for this call
              const queue = yield* Queue.unbounded<StreamPart>();
              const completion = yield* Deferred.make<void>();
              currentQueue = queue;
              currentCompletion = completion;

              // Increment call count and notify waiters
              callCount++;
              const waiter = callWaiters[callCount - 1];
              if (waiter) yield* Deferred.succeed(waiter, void 0);

              return Stream.fromQueue(queue).pipe(
                Stream.interruptWhen(Deferred.await(completion)),
                Stream.onDone(() => Queue.shutdown(queue)),
              );
            }).pipe(Stream.unwrap),
          generateText: () => Effect.die("not implemented"),
          generateObject: () => Effect.die("not implemented"),
        };

        // Return context with same service under both tags
        return Context.empty().pipe(
          Context.add(TestLanguageModel, service),
          Context.add(LanguageModel.LanguageModel, service),
        );
      }),
    );
}
