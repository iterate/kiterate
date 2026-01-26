/**
 * CodeExecutionRuntime Service
 *
 * Provides the runtime dependencies for code execution (fetch, execa, process.env).
 * This allows for dependency injection in tests - swap out the live implementation
 * for mocks that control external API calls and environment variables.
 */
import { Context, Layer } from "effect";
import { execa as execaReal } from "execa";

// -------------------------------------------------------------------------------------
// Service Definition
// -------------------------------------------------------------------------------------

/**
 * Runtime dependencies for code execution.
 *
 * These are the globals that codemode blocks have access to.
 */
export interface CodeExecutionRuntimeShape {
  /** The fetch function for HTTP requests */
  readonly fetch: typeof global.fetch;
  /** The execa function for running shell commands */
  readonly execa: typeof execaReal | ExecaFn;
  /** Environment variables */
  readonly env: Record<string, string | undefined>;
  /** The require function for loading modules (optional) */
  readonly require: typeof global.require;
}

export class CodeExecutionRuntime extends Context.Tag("@kiterate/CodeExecutionRuntime")<
  CodeExecutionRuntime,
  CodeExecutionRuntimeShape
>() {}

// -------------------------------------------------------------------------------------
// Live Layer
// -------------------------------------------------------------------------------------

/**
 * Live implementation using real globals.
 */
export const liveLayer = Layer.succeed(CodeExecutionRuntime, {
  fetch: global.fetch,
  execa: execaReal,
  env: process.env as Record<string, string | undefined>,
  require: global.require,
});

// -------------------------------------------------------------------------------------
// Test Layer Factory
// -------------------------------------------------------------------------------------

/**
 * Options for creating a test runtime.
 */
export interface TestRuntimeOptions {
  /** Mock fetch implementation */
  fetch?: typeof global.fetch;
  /** Mock execa implementation (can be full execa or simplified ExecaFn) */
  execa?: typeof execaReal | ExecaFn;
  /** Mock environment variables */
  env?: Record<string, string | undefined>;
  /** Mock require (defaults to real require) */
  require?: typeof global.require;
}

/**
 * Create a test layer with mocked dependencies.
 *
 * Any options not provided will use the real implementation.
 */
export const testLayer = (options: TestRuntimeOptions = {}): Layer.Layer<CodeExecutionRuntime> =>
  Layer.succeed(CodeExecutionRuntime, {
    fetch: options.fetch ?? global.fetch,
    execa: options.execa ?? execaReal,
    env: options.env ?? {},
    require: options.require ?? global.require,
  });

/**
 * Create a mock fetch that returns predefined responses based on URL patterns.
 */
export const createMockFetch = (
  handlers: Array<{
    pattern: string | RegExp;
    response: Response | ((request: Request) => Response | Promise<Response>);
  }>,
): typeof global.fetch => {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    for (const handler of handlers) {
      const matches =
        typeof handler.pattern === "string"
          ? url.includes(handler.pattern)
          : handler.pattern.test(url);

      if (matches) {
        if (typeof handler.response === "function") {
          return handler.response(new Request(url, init));
        }
        return handler.response.clone();
      }
    }

    throw new Error(`No mock handler for URL: ${url}`);
  }) as typeof global.fetch;
};

/** The minimal execa result shape we use */
export interface ExecaResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failed: boolean;
  command: string;
}

/** A simplified execa function type for our purposes */
export type ExecaFn = (command: string, args?: string[]) => Promise<ExecaResult>;

/**
 * Create a mock execa that returns predefined outputs based on command.
 */
export const createMockExeca = (
  handlers: Array<{
    command: string | RegExp;
    result:
      | { stdout: string; stderr?: string; exitCode?: number }
      | ((cmd: string, args?: string[]) => { stdout: string; stderr?: string; exitCode?: number });
  }>,
): ExecaFn => {
  return async (command: string, args?: string[]): Promise<ExecaResult> => {
    const fullCommand = args ? `${command} ${args.join(" ")}` : command;

    for (const handler of handlers) {
      const matches =
        typeof handler.command === "string"
          ? fullCommand.includes(handler.command) || command === handler.command
          : handler.command.test(fullCommand);

      if (matches) {
        const result =
          typeof handler.result === "function" ? handler.result(command, args) : handler.result;

        return {
          stdout: result.stdout,
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
          failed: (result.exitCode ?? 0) !== 0,
          command: fullCommand,
        };
      }
    }

    throw new Error(`No mock handler for command: ${fullCommand}`);
  };
};
