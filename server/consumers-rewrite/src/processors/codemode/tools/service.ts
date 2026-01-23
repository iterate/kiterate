/**
 * Tool Registry Service
 *
 * Service for managing tool implementations that can be invoked from codemode blocks.
 * The service holds the actual executable implementations, while events carry metadata.
 */
import { Context, Effect, Option } from "effect";

import type { ToolDefinition } from "./types.js";

// -------------------------------------------------------------------------------------
// Service Definition
// -------------------------------------------------------------------------------------

/**
 * ToolRegistry service - manages tool implementations.
 *
 * The registry stores executable tool implementations that can be looked up by name.
 * Tools are registered either at startup (via layer construction) or dynamically
 * (via the register method).
 */
export class ToolRegistry extends Context.Tag("@app/ToolRegistry")<
  ToolRegistry,
  {
    /**
     * Get a tool implementation by name.
     * Returns Option.none() if the tool is not registered.
     */
    readonly get: (name: string) => Option.Option<ToolDefinition>;

    /**
     * Register a tool implementation.
     * If a tool with the same name exists, it will be replaced.
     */
    readonly register: (tool: ToolDefinition) => Effect.Effect<void>;

    /**
     * Unregister a tool by name.
     * Returns true if the tool was found and removed.
     */
    readonly unregister: (name: string) => Effect.Effect<boolean>;

    /**
     * Get all registered tool names.
     */
    readonly list: () => ReadonlyArray<string>;
  }
>() {}
