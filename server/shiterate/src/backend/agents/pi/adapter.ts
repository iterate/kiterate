/**
 * Pi Harness Adapter
 *
 * Connects a Pi coding agent session to an event stream.
 * - Subscribes to stream for action events (prompt, abort)
 * - Calls Pi SDK methods in response
 * - Wraps Pi SDK events and appends to stream
 */
import type {
  AgentSession,
  AgentSessionEvent,
  SessionManager as SessionManagerType,
} from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Console } from "effect";
import { SessionCreatePayload } from "./types.ts";

/**
 * State of the Pi adapter
 */
interface PiAdapterState {
  session: AgentSession | null;
  sessionManager: SessionManagerType | null;
  eventUnsubscribe: (() => void) | null;
}

export interface PiAdapterCallbacks {
  onEvent?: (event: AgentSessionEvent) => void;
  onError?: (error: unknown, context: string) => void;
  onSessionCreate?: (payload: SessionCreatePayload) => void;
}

export interface PiAdapterHandle {
  ensureSession: (payload?: SessionCreatePayload) => Promise<void>;
  prompt: (content: string) => Promise<void>;
  abort: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Create and run a Pi adapter for a given agent session.
 *
 * The adapter:
 * 1. Creates a Pi session on demand
 * 2. Forwards prompts to the Pi session
 * 3. Emits Pi SDK events to callbacks
 *
 * @param callbacks - Optional callbacks for events and errors
 */
export const createPiAdapter = (callbacks: PiAdapterCallbacks = {}): PiAdapterHandle => {
  const state: PiAdapterState = {
    session: null,
    sessionManager: null,
    eventUnsubscribe: null,
  };

  const subscribeToPiEvents = (session: AgentSession): void => {
    if (state.eventUnsubscribe) {
      state.eventUnsubscribe();
    }

    state.eventUnsubscribe = session.subscribe((event) => {
      callbacks.onEvent?.(event);
    });
  };

  const ensureSession = async (payload?: SessionCreatePayload): Promise<void> => {
    if (state.session) return;

    try {
      await Console.log("[Pi Adapter] Creating session...");

      const authStorage = discoverAuthStorage();
      const modelRegistry = discoverModels(authStorage);
      const cwd = payload?.cwd ?? process.env.INIT_CWD ?? process.cwd();

      const sessionManager = payload?.sessionFile
        ? SessionManager.open(payload.sessionFile)
        : SessionManager.create(cwd);

      const { session } = await createAgentSession({
        sessionManager,
        authStorage,
        modelRegistry,
        cwd,
      });

      state.session = session;
      state.sessionManager = sessionManager;
      subscribeToPiEvents(session);

      callbacks.onSessionCreate?.(
        new SessionCreatePayload({
          cwd,
          model: payload?.model,
          thinkingLevel: payload?.thinkingLevel,
          sessionFile: payload?.sessionFile,
        }),
      );

      const sessionFile = sessionManager.getSessionFile();
      await Console.log(
        `[Pi Adapter] Session created${sessionFile ? ` (file: ${sessionFile})` : " (in-memory)"}`,
      );
    } catch (error) {
      await Console.error(
        `[Pi Adapter] Session create error: ${error instanceof Error ? error.message : String(error)}`,
      );
      callbacks.onError?.(error, "session-create");
      throw error;
    }
  };

  const prompt = async (content: string): Promise<void> => {
    try {
      if (!state.session) {
        await Console.error("[Pi Adapter] No session - creating session before prompt");
        await ensureSession();
      }

      if (!state.session) {
        await Console.error("[Pi Adapter] No session - ignoring prompt");
        callbacks.onError?.("No session available", "prompt");
        return;
      }

      await Console.log(`[Pi Adapter] Sending prompt: ${content.slice(0, 50)}...`);
      await state.session.prompt(content);
      await Console.log("[Pi Adapter] Prompt completed");
    } catch (error) {
      await Console.error(
        `[Pi Adapter] Prompt error: ${error instanceof Error ? error.message : String(error)}`,
      );
      callbacks.onError?.(error, "prompt");
    }
  };

  const abort = async (): Promise<void> => {
    if (!state.session) {
      await Console.error("[Pi Adapter] No session - ignoring abort");
      return;
    }

    await Console.log("[Pi Adapter] Aborting...");
    await state.session.abort();
    await Console.log("[Pi Adapter] Aborted");
  };

  const close = async (): Promise<void> => {
    if (state.eventUnsubscribe) {
      state.eventUnsubscribe();
    }
  };

  return {
    ensureSession,
    prompt,
    abort,
    close,
  };
};
