/**
 * Interceptors - event interception before storage
 *
 * @example
 * ```ts
 * import * as Interceptors from "./interceptors/index.js";
 *
 * // Register an interceptor
 * const registry = yield* Interceptors.InterceptorRegistry;
 * registry.register({
 *   name: "my-interceptor",
 *   match: `type = "user-message"`,
 * });
 *
 * // Watch for intercepted events and re-emit
 * yield* stream.subscribe({}).pipe(
 *   Stream.runForEach((event) =>
 *     Effect.gen(function* () {
 *       if (event.type.startsWith("intercepted:")) {
 *         // Transform and re-emit
 *         yield* stream.append(transformedEvent);
 *       }
 *     })
 *   )
 * );
 * ```
 */
export * from "./interceptor.js";
export * from "./service.js";
export * as Matcher from "./matcher.js";
