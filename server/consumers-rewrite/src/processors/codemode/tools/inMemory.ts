/**
 * In-Memory Tool Registry Layer
 *
 * An in-memory implementation of the ToolRegistry service.
 */
import { Effect, Layer, Option } from "effect";

import { ToolRegistry } from "./service.js";
import type { ToolDefinition } from "./types.js";

// -------------------------------------------------------------------------------------
// In-Memory Implementation
// -------------------------------------------------------------------------------------

/**
 * Create an in-memory ToolRegistry layer.
 *
 * @param initialTools - Optional array of tools to pre-register
 */
export const inMemoryLayer = (
  initialTools: ReadonlyArray<ToolDefinition<any, any>> = [],
): Layer.Layer<ToolRegistry> =>
  Layer.effect(
    ToolRegistry,
    Effect.sync(() => {
      const tools = new Map<string, ToolDefinition>(initialTools.map((t) => [t.name, t]));

      return ToolRegistry.of({
        get: (name) => Option.fromNullable(tools.get(name)),

        register: (tool) =>
          Effect.sync(() => {
            tools.set(tool.name, tool);
          }),

        unregister: (name) =>
          Effect.sync(() => {
            return tools.delete(name);
          }),

        list: () => Array.from(tools.keys()),
      });
    }),
  );

/**
 * Empty in-memory ToolRegistry layer (no pre-registered tools).
 */
export const emptyLayer: Layer.Layer<ToolRegistry> = inMemoryLayer([]);
