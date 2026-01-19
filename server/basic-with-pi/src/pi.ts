/**
 * Pi Agent Adapter
 *
 * Simple adapter that connects PI coding agent sessions to event streams.
 * Persists session mappings to a YAML file so sessions survive restarts.
 *
 * Interface:
 * - handleEvent(agentPath, event) - called when any event is added to a /pi/* path
 * - yields wrapped PI SDK events via onPiEvent callback
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Wrapped PI event for the stream - matches iterate:agent:harness:pi:event-received */
export interface WrappedPiEvent {
  type: "iterate:agent:harness:pi:event-received";
  version: number;
  createdAt: string;
  eventStreamId: string;
  payload: {
    piEventType: string;
    piEvent: AgentSessionEvent;
  };
}

/** Error event - matches iterate:agent:harness:pi:error */
export interface PiErrorEvent {
  type: "iterate:agent:harness:pi:error";
  version: number;
  createdAt: string;
  eventStreamId: string;
  payload: {
    message: string;
    context?: string;
    stack?: string;
  };
}

/** Session created event */
export interface PiSessionCreatedEvent {
  type: "iterate:agent:harness:pi:action:session-create:called";
  version: number;
  createdAt: string;
  eventStreamId: string;
  payload: {
    cwd: string;
    sessionFile: string;
  };
}

/** Session restored event */
export interface PiSessionRestoredEvent {
  type: "iterate:agent:harness:pi:session-restored";
  version: number;
  createdAt: string;
  eventStreamId: string;
  payload: {
    sessionFile: string;
  };
}

export type PiOutputEvent = WrappedPiEvent | PiErrorEvent | PiSessionCreatedEvent | PiSessionRestoredEvent;

/** Callback when PI produces events */
export type OnPiEvent = (agentPath: string, event: PiOutputEvent) => void;

/** Persisted session mapping */
interface SessionMapping {
  agentPath: string;
  sessionFile: string;
  createdAt: string;
}

interface SessionsFile {
  sessions: SessionMapping[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Manager
// ─────────────────────────────────────────────────────────────────────────────

interface SessionState {
  session: AgentSession;
  sessionManager: ReturnType<typeof SessionManager.create> | ReturnType<typeof SessionManager.open>;
  sessionFile: string;
  unsubscribe: () => void;
}

export class PiAdapter {
  private sessions = new Map<string, SessionState>();
  private onPiEvent: OnPiEvent;
  private sessionsFilePath: string;
  private cwd: string;

  constructor(onPiEvent: OnPiEvent, sessionsFilePath: string) {
    this.onPiEvent = onPiEvent;
    this.sessionsFilePath = sessionsFilePath;
    this.cwd = process.env.INIT_CWD ?? process.cwd();

    // Ensure directory exists
    const dir = path.dirname(sessionsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Load persisted sessions and reconnect to existing PI sessions.
   */
  async loadSessions(): Promise<void> {
    if (!fs.existsSync(this.sessionsFilePath)) {
      console.log(`[Pi] No sessions file found at ${this.sessionsFilePath}`);
      return;
    }

    try {
      const content = fs.readFileSync(this.sessionsFilePath, "utf-8");
      const data = YAML.parse(content) as SessionsFile;

      if (!data?.sessions?.length) {
        console.log(`[Pi] No sessions in file`);
        return;
      }

      console.log(`[Pi] Loading ${data.sessions.length} sessions...`);

      for (const mapping of data.sessions) {
        try {
          await this.restoreSession(mapping.agentPath, mapping.sessionFile);
        } catch (err) {
          console.error(`[Pi] Failed to restore session for ${mapping.agentPath}:`, err);
        }
      }
    } catch (err) {
      console.error(`[Pi] Failed to load sessions file:`, err);
    }
  }

  /**
   * Save session mappings to YAML file.
   */
  private saveSessions(): void {
    const sessions: SessionMapping[] = [];

    for (const [agentPath, state] of this.sessions.entries()) {
      sessions.push({
        agentPath,
        sessionFile: state.sessionFile,
        createdAt: new Date().toISOString(),
      });
    }

    const data: SessionsFile = { sessions };
    const content = YAML.stringify(data);

    try {
      fs.writeFileSync(this.sessionsFilePath, content, "utf-8");
      console.log(`[Pi] Saved ${sessions.length} session mappings`);
    } catch (err) {
      console.error(`[Pi] Failed to save sessions file:`, err);
    }
  }

  /**
   * Handle an incoming event on a PI agent path.
   * - Ensures session exists (creates if needed)
   * - If it's a user message, prompts the PI session
   */
  async handleEvent(agentPath: string, event: unknown): Promise<void> {
    console.log(`[Pi] handleEvent called for ${agentPath}`);
    
    // Ensure session exists
    let state: SessionState;
    try {
      state = await this.getOrCreateSession(agentPath);
    } catch (err) {
      console.error(`[Pi] Failed to get/create session for ${agentPath}:`, err);
      throw err;
    }

    // Check if it's a user message
    const content = extractUserMessage(event);
    if (content) {
      console.log(`[Pi] Prompting ${agentPath}: ${content.slice(0, 50)}...`);
      try {
        await state.session.prompt(content);
        console.log(`[Pi] Prompt completed for ${agentPath}`);
      } catch (err) {
        console.error(`[Pi] Prompt error for ${agentPath}:`, err);
        this.emitError(agentPath, err, "prompt");
      }
    } else {
      console.log(`[Pi] No user message content found in event for ${agentPath}`);
    }
  }

  /**
   * Restore an existing PI session from a session file.
   */
  private async restoreSession(agentPath: string, sessionFile: string): Promise<SessionState> {
    if (this.sessions.has(agentPath)) {
      return this.sessions.get(agentPath)!;
    }

    console.log(`[Pi] Restoring session for ${agentPath} from ${sessionFile}`);

    try {
      const authStorage = discoverAuthStorage();
      const modelRegistry = discoverModels(authStorage);

      const sessionManager = SessionManager.open(sessionFile);
      const { session } = await createAgentSession({
        sessionManager,
        authStorage,
        modelRegistry,
        cwd: this.cwd,
      });

      // Subscribe to PI events - wrap in try-catch to prevent unhandled errors
      const unsubscribe = session.subscribe((piEvent) => {
        try {
          this.onPiEvent(agentPath, {
            type: "iterate:agent:harness:pi:event-received",
            version: 1,
            createdAt: new Date().toISOString(),
            eventStreamId: agentPath,
            payload: {
              piEventType: piEvent.type,
              piEvent,
            },
          });
        } catch (err) {
          console.error(`[Pi] Error in event callback for ${agentPath}:`, err);
        }
      });

      const state: SessionState = { session, sessionManager, sessionFile, unsubscribe };
      this.sessions.set(agentPath, state);

      // Emit session restored event
      this.onPiEvent(agentPath, {
        type: "iterate:agent:harness:pi:session-restored",
        version: 1,
        createdAt: new Date().toISOString(),
        eventStreamId: agentPath,
        payload: {
          sessionFile,
        },
      });

      console.log(`[Pi] Session restored for ${agentPath}`);
      return state;
    } catch (err) {
      this.emitError(agentPath, err, "session-restore");
      throw err;
    }
  }

  /**
   * Get or create a PI session for an agent path.
   */
  private async getOrCreateSession(agentPath: string): Promise<SessionState> {
    const existing = this.sessions.get(agentPath);
    if (existing) return existing;

    console.log(`[Pi] Creating session for ${agentPath}`);

    try {
      console.log(`[Pi] Discovering auth storage...`);
      const authStorage = discoverAuthStorage();
      console.log(`[Pi] Discovering models...`);
      const modelRegistry = discoverModels(authStorage);

      console.log(`[Pi] Creating session manager in ${this.cwd}...`);
      const sessionManager = SessionManager.create(this.cwd);
      console.log(`[Pi] Creating agent session...`);
      const { session } = await createAgentSession({
        sessionManager,
        authStorage,
        modelRegistry,
        cwd: this.cwd,
      });
      console.log(`[Pi] Agent session created`);

      const sessionFile = sessionManager.getSessionFile();
      if (!sessionFile) {
        throw new Error("Session manager did not return a session file");
      }

      // Subscribe to PI events - wrap in try-catch to prevent unhandled errors
      console.log(`[Pi] Subscribing to session events...`);
      const unsubscribe = session.subscribe((piEvent) => {
        try {
          this.onPiEvent(agentPath, {
            type: "iterate:agent:harness:pi:event-received",
            version: 1,
            createdAt: new Date().toISOString(),
            eventStreamId: agentPath,
            payload: {
              piEventType: piEvent.type,
              piEvent,
            },
          });
        } catch (err) {
          console.error(`[Pi] Error in event callback for ${agentPath}:`, err);
        }
      });

      const state: SessionState = { session, sessionManager, sessionFile, unsubscribe };
      this.sessions.set(agentPath, state);

      // Save mapping
      console.log(`[Pi] Saving session mapping...`);
      this.saveSessions();

      // Emit session created event
      this.onPiEvent(agentPath, {
        type: "iterate:agent:harness:pi:action:session-create:called",
        version: 1,
        createdAt: new Date().toISOString(),
        eventStreamId: agentPath,
        payload: {
          cwd: this.cwd,
          sessionFile,
        },
      });

      console.log(`[Pi] Session created for ${agentPath} (file: ${sessionFile})`);
      return state;
    } catch (err) {
      this.emitError(agentPath, err, "session-create");
      throw err;
    }
  }

  private emitError(agentPath: string, error: unknown, context?: string): void {
    this.onPiEvent(agentPath, {
      type: "iterate:agent:harness:pi:error",
      version: 1,
      createdAt: new Date().toISOString(),
      eventStreamId: agentPath,
      payload: {
        message: error instanceof Error ? error.message : String(error),
        context,
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }

  /**
   * Close a session.
   */
  closeSession(agentPath: string): void {
    const state = this.sessions.get(agentPath);
    if (state) {
      state.unsubscribe();
      this.sessions.delete(agentPath);
      this.saveSessions();
      console.log(`[Pi] Session closed for ${agentPath}`);
    }
  }

  /**
   * Close all sessions.
   */
  closeAll(): void {
    for (const agentPath of this.sessions.keys()) {
      this.closeSession(agentPath);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract user message content from various event formats.
 */
function extractUserMessage(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;

  const e = event as Record<string, unknown>;
  const eventType = e.type as string | undefined;

  // Direct content field
  if (typeof e.content === "string" && e.content) {
    return e.content;
  }

  // Payload with content
  if (typeof e.payload === "object" && e.payload !== null) {
    const payload = e.payload as Record<string, unknown>;
    if (typeof payload.content === "string" && payload.content) {
      return payload.content;
    }
    if (typeof payload.text === "string" && payload.text) {
      return payload.text;
    }
    if (typeof payload.message === "string" && payload.message) {
      return payload.message;
    }
  }

  // Known user message event types
  if (
    eventType === "iterate:agent:action:send-user-message:called" ||
    eventType === "iterate:agent:harness:pi:action:prompt:called" ||
    eventType === "user-message" ||
    eventType === "prompt"
  ) {
    // Already checked payload above, try text/message fields
    if (typeof e.text === "string" && e.text) return e.text;
    if (typeof e.message === "string" && e.message) return e.message;
  }

  return null;
}
