/**
 * InterceptorRegistry Service
 *
 * A service that holds registered interceptors. Processors can register
 * interceptors during their run, and EventStream uses this registry to
 * apply interception logic before storing events.
 */
import { Context, Layer } from "effect";

import type { Interceptor } from "./interceptor.js";

// -------------------------------------------------------------------------------------
// Service definition
// -------------------------------------------------------------------------------------

export class InterceptorRegistry extends Context.Tag("@app/InterceptorRegistry")<
  InterceptorRegistry,
  {
    /** Get all registered interceptors in registration order */
    readonly list: () => ReadonlyArray<Interceptor>;

    /**
     * Register an interceptor.
     * Interceptors are evaluated in registration order; first match wins.
     */
    readonly register: (interceptor: Interceptor) => void;
  }
>() {}

// -------------------------------------------------------------------------------------
// Layers
// -------------------------------------------------------------------------------------

/**
 * Creates an empty interceptor registry.
 * Processors can register interceptors during their run.
 */
export const emptyLayer = Layer.sync(InterceptorRegistry, () => {
  const interceptors: Interceptor[] = [];

  return InterceptorRegistry.of({
    list: () => interceptors,
    register: (interceptor) => {
      interceptors.push(interceptor);
    },
  });
});
