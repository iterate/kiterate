/**
 * Interceptor Matching Logic
 *
 * Uses JSONata expressions to match events against interceptor criteria.
 * Compiled expressions are cached for performance.
 */
import jsonata from "@mmkal/jsonata/sync";

import type { EventInput } from "../domain.js";
import type { Interceptor } from "./interceptor.js";

// -------------------------------------------------------------------------------------
// Expression cache
// -------------------------------------------------------------------------------------

const cache = new Map<string, ReturnType<typeof jsonata>>();

const compile = (expr: string): ReturnType<typeof jsonata> => {
  let compiled = cache.get(expr);
  if (!compiled) {
    compiled = jsonata(expr);
    cache.set(expr, compiled);
  }
  return compiled;
};

// -------------------------------------------------------------------------------------
// Matching
// -------------------------------------------------------------------------------------

/**
 * Check if an interceptor matches an event.
 *
 * The JSONata expression receives { type, payload } and should return
 * a truthy value to indicate a match.
 */
export const matches = (interceptor: Interceptor, event: EventInput): boolean => {
  const compiled = compile(interceptor.match);
  const result = compiled.evaluate({
    type: event.type,
    payload: event.payload,
  });
  return Boolean(result);
};
