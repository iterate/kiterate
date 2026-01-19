/**
 * Pi Agent Adapter and Session Manager
 *
 * Connects a Pi coding agent session to an event stream.
 * - Creates Pi sessions on demand
 * - Forwards prompts to the Pi session
 * - Wraps Pi SDK events and appends to stream
 *
 * Events follow the Iterate envelope format with verbatim harness payloads.
 */
import * as fs from "node:fs";
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
import { Console, Schema } from "effect";
import YAML from "yaml";

// ─────────────────────────────────────────────────────────────────────────────
// Types & Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const EventStreamId = Schema.String.pipe(Schema.nonEmptyString());
export type EventStreamId = typeof EventStreamId.Type;

/**
 * Base envelope for all Iterate events.
 */
export class IterateEventEnvelope extends Schema.Class<IterateEventEnvelope>("IterateEventEnvelope")({
  type: Schema.String,
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

// Event type constants
export const PiEventTypes = {
  SESSION_CREATE: "iterate:agent:harness:pi:action:session-create:called",
  PROMPT: "iterate:agent:harness:pi:action:prompt:called",
  ABORT: "iterate:agent:harness:pi:action:abort:called",
  EVENT_RECEIVED: "iterate:agent:harness:pi:event-received",
  ERROR: "iterate:agent:harness:pi:error",
} as const;

export const AgentActionTypes = {
  SEND_USER_MESSAGE: "iterate:agent:action:send-user-message:called",
} as const;

/**
 * Payload schemas
 */
export class SessionCreatePayload extends Schema.Class<SessionCreatePayload>("SessionCreatePayload")({
  cwd: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
}) {}

export class PromptPayload extends Schema.Class<PromptPayload>("PromptPayload")({
  content: Schema.String,
}) {}

export class AbortPayload extends Schema.Class<AbortPayload>("AbortPayload")({}) {}

export class PiEventReceivedPayload extends Schema.Class<PiEventReceivedPayload>("PiEventReceivedPayload")({
  piEventType: Schema.String,
  piEvent: Schema.Unknown,
}) {}

/**
 * Typed action events
 */
export class SessionCreateEvent extends Schema.Class<SessionCreateEvent>("SessionCreateEvent")({
  type: Schema.Literal(PiEventTypes.SESSION_CREATE),
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: SessionCreatePayload,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

export class PromptEvent extends Schema.Class<PromptEvent>("PromptEvent")({
  type: Schema.Literal(PiEventTypes.PROMPT),
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: PromptPayload,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

export class AbortEvent extends Schema.Class<AbortEvent>("AbortEvent")({
  type: Schema.Literal(PiEventTypes.ABORT),
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: AbortPayload,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

export class PiEventReceivedEvent extends Schema.Class<PiEventReceivedEvent>("PiEventReceivedEvent")({
  type: Schema.Literal(PiEventTypes.EVENT_RECEIVED),
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: PiEventReceivedPayload,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

export const PiIterateEvent = Schema.Union(SessionCreateEvent, PromptEvent, AbortEvent, PiEventReceivedEvent);
export type PiIterateEvent = typeof PiIterateEvent.Type;

// ─────────────────────────────────────────────────────────────────────────────
// Event Helpers
// ─────────────────────────────────────────────────────────────────────────────

export const makeIterateEvent = <T extends { type: string }>(
  eventStreamId: EventStreamId,
  type: T["type"],
  payload?: unknown,
  metadata?: Record<string, unknown>,
): IterateEventEnvelope =>
  new IterateEventEnvelope({
    type,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload,
    metadata,
  });

export const makeSessionCreateEvent = (
  eventStreamId: EventStreamId,
  options?: { cwd?: string; model?: string; thinkingLevel?: string; sessionFile?: string },
): SessionCreateEvent => {
  const payloadFields: { cwd?: string; model?: string; thinkingLevel?: string; sessionFile?: string } = {};
  if (options?.cwd !== undefined) payloadFields.cwd = options.cwd;
  if (options?.model !== undefined) payloadFields.model = options.model;
  if (options?.thinkingLevel !== undefined) payloadFields.thinkingLevel = options.thinkingLevel;
  if (options?.sessionFile !== undefined) payloadFields.sessionFile = options.sessionFile;

  return new SessionCreateEvent({
    type: PiEventTypes.SESSION_CREATE,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: new SessionCreatePayload(payloadFields),
  });
};

export const makePromptEvent = (eventStreamId: EventStreamId, content: string): PromptEvent =>
  new PromptEvent({
    type: PiEventTypes.PROMPT,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: new PromptPayload({ content }),
  });

export const makeAbortEvent = (eventStreamId: EventStreamId): AbortEvent =>
  new AbortEvent({
    type: PiEventTypes.ABORT,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: new AbortPayload({}),
  });

export const makePiEventReceivedEvent = (
  eventStreamId: EventStreamId,
  piEventType: string,
  piEvent: unknown,
): PiEventReceivedEvent =>
  new PiEventReceivedEvent({
    type: PiEventTypes.EVENT_RECEIVED,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: new PiEventReceivedPayload({ piEventType, piEvent }),
  });

export const makePiErrorEvent = (eventStreamId: EventStreamId, error: unknown, context?: string): IterateEventEnvelope =>
  new IterateEventEnvelope({
    type: PiEventTypes.ERROR,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context,
    },
  });

// ─────────────────────────────────────────────────────────────────────────────
// Pi Adapter
// ─────────────────────────────────────────────────────────────────────────────

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
      await Console.log(`[Pi Adapter] Session created${sessionFile ? ` (file: ${sessionFile})` : " (in-memory)"}`);
    } catch (error) {
      await Console.error(`[Pi Adapter] Session create error: ${error instanceof Error ? error.message : String(error)}`);
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
      await Console.error(`[Pi Adapter] Prompt error: ${error instanceof Error ? error.message : String(error)}`);
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

// ─────────────────────────────────────────────────────────────────────────────
// PI Session Manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store interface compatible with both StreamStore and FileBackedStreamStore.
 */
interface StreamStoreInterface {
  has(path: string): boolean;
  create(path: string, options?: { contentType?: string }): unknown;
  append(path: string, data: Uint8Array, options?: { contentType?: string }): unknown;
}

interface PiSessionMapping {
  agentPath: string;
  sessionFile?: string;
  createdAt: string;
}

interface PiSessionsFile {
  sessions: PiSessionMapping[];
}

/**
 * Manages PI agent sessions and their mapping to durable streams.
 */
export class PiSessionManager {
  private sessions = new Map<string, PiAdapterHandle>();
  private sessionsFilePath: string;
  private store: StreamStoreInterface;

  constructor(sessionsFilePath: string, store: StreamStoreInterface) {
    this.sessionsFilePath = sessionsFilePath;
    this.store = store;
  }

  /**
   * Load sessions from YAML file and reconnect to existing PI sessions.
   */
  async loadSessions(): Promise<void> {
    if (!fs.existsSync(this.sessionsFilePath)) {
      console.log(`[PI Manager] No sessions file found at ${this.sessionsFilePath}`);
      return;
    }

    try {
      const content = fs.readFileSync(this.sessionsFilePath, "utf-8");
      const data = YAML.parse(content) as PiSessionsFile;

      if (!data?.sessions?.length) {
        console.log(`[PI Manager] No sessions in file`);
        return;
      }

      console.log(`[PI Manager] Loading ${data.sessions.length} sessions...`);

      for (const mapping of data.sessions) {
        try {
          await this.getOrCreateAdapter(mapping.agentPath, mapping.sessionFile);
          console.log(`[PI Manager] Restored session for ${mapping.agentPath}`);
        } catch (err) {
          console.error(`[PI Manager] Failed to restore session for ${mapping.agentPath}:`, err);
        }
      }
    } catch (err) {
      console.error(`[PI Manager] Failed to load sessions file:`, err);
    }
  }

  /**
   * Save sessions to YAML file.
   */
  private saveSessions(): void {
    const sessions: PiSessionMapping[] = [];

    for (const agentPath of this.sessions.keys()) {
      sessions.push({
        agentPath,
        createdAt: new Date().toISOString(),
      });
    }

    const data: PiSessionsFile = { sessions };
    const content = YAML.stringify(data);

    try {
      fs.writeFileSync(this.sessionsFilePath, content, "utf-8");
    } catch (err) {
      console.error(`[PI Manager] Failed to save sessions file:`, err);
    }
  }

  /**
   * Check if a path is a PI agent path (starts with /pi/).
   * Agent paths should always start with "/" (e.g., "/pi/my-session").
   */
  isPiAgentPath(agentPath: string): boolean {
    return agentPath.startsWith("/pi/");
  }

  /**
   * Get or create a PI adapter for an agent path.
   * Agent path should start with "/" (e.g., "/pi/my-session").
   */
  async getOrCreateAdapter(agentPath: string, sessionFile?: string): Promise<PiAdapterHandle> {
    const existing = this.sessions.get(agentPath);
    if (existing) return existing;

    const eventStreamId = agentPath as EventStreamId;
    // agentPath already starts with /, so we use /agents + agentPath
    const streamPath = `/agents${agentPath}`;

    // Ensure the stream exists BEFORE creating the adapter
    // This is critical because ensureSession triggers callbacks that append to the stream
    if (!this.store.has(streamPath)) {
      this.store.create(streamPath, { contentType: "application/json" });
    }

    const adapter = createPiAdapter({
      onEvent: (event) => {
        this.appendToStream(agentPath, makePiEventReceivedEvent(eventStreamId, event.type, event));
      },
      onError: (error, context) => {
        this.appendToStream(agentPath, makePiErrorEvent(eventStreamId, error, context));
      },
      onSessionCreate: (payload: SessionCreatePayload) => {
        this.appendToStream(
          agentPath,
          makeSessionCreateEvent(eventStreamId, {
            cwd: payload.cwd,
            model: payload.model,
            thinkingLevel: payload.thinkingLevel,
            sessionFile: payload.sessionFile,
          }),
        );
      },
    });

    // Ensure session is created
    await adapter.ensureSession({ sessionFile });

    this.sessions.set(agentPath, adapter);
    this.saveSessions();

    return adapter;
  }

  /**
   * Append an event to a stream.
   * Agent path should start with "/" (e.g., "/pi/my-session").
   */
  private appendToStream(agentPath: string, event: unknown): void {
    // agentPath already starts with /, so we use /agents + agentPath
    const streamPath = `/agents${agentPath}`;
    const data = new TextEncoder().encode(JSON.stringify(event));

    try {
      this.store.append(streamPath, data, { contentType: "application/json" });
    } catch (err) {
      console.error(`[PI Manager] Failed to append to stream ${streamPath}:`, err);
    }
  }

  /**
   * Handle an incoming event on a PI stream.
   * Returns true if the event was handled (was a prompt).
   */
  async handleEvent(agentPath: string, event: unknown): Promise<boolean> {
    if (!this.isPiAgentPath(agentPath)) return false;

    const e = event as Record<string, unknown>;
    const eventType = e.type as string | undefined;

    // Handle prompt events
    if (eventType === "iterate:agent:harness:pi:action:prompt:called") {
      const payload = e.payload as { content?: string } | undefined;
      const content = payload?.content;

      if (content) {
        const adapter = await this.getOrCreateAdapter(agentPath);
        await adapter.prompt(content);
        return true;
      }
    }

    // Handle generic user message events
    if (eventType === "iterate:agent:action:send-user-message:called") {
      const payload = e.payload as { content?: string; text?: string; message?: string } | undefined;
      const content = payload?.content ?? payload?.text ?? payload?.message;

      if (content) {
        const adapter = await this.getOrCreateAdapter(agentPath);
        await adapter.prompt(content);
        return true;
      }
    }

    return false;
  }

  /**
   * Close a session for an agent path.
   */
  async closeSession(agentPath: string): Promise<void> {
    const adapter = this.sessions.get(agentPath);
    if (adapter) {
      await adapter.close();
      this.sessions.delete(agentPath);
      this.saveSessions();
    }
  }
}
