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

interface SessionMapping {
  agentPath: string;
  sessionFile: string;
  createdAt: string;
}

interface SessionsFile {
  sessions: SessionMapping[];
}

interface SessionState {
  session: AgentSession;
  sessionManager: ReturnType<typeof SessionManager.create> | ReturnType<typeof SessionManager.open>;
  sessionFile: string;
  unsubscribe: () => void;
}

export interface PiAdapterConfig {
  append: (agentPath: string, event: unknown) => void;
  sessionsFile: string;
}

export class PiAdapter {
  private sessions = new Map<string, SessionState>();
  private config: PiAdapterConfig;
  private cwd: string;

  constructor(config: PiAdapterConfig) {
    this.config = config;
    this.cwd = process.env.INIT_CWD ?? process.cwd();

    const dir = path.dirname(config.sessionsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async on(agentPath: string, event: unknown): Promise<void> {
    if (!agentPath.startsWith("/pi/")) return;

    const content = this.extractUserMessageContent(event);
    if (!content) return;

    const session = await this.getOrCreateSession(agentPath);
    await session.session.prompt(content);
  }

  private extractUserMessageContent(event: unknown): string | null {
    if (typeof event !== "object" || event === null) return null;
    const e = event as { type?: string; payload?: { content?: string } };
    if (e.type === "iterate:agent:action:send-user-message:called" && e.payload?.content) {
      return e.payload.content;
    }
    return null;
  }

  private wrapPiEvent(agentPath: string, piEvent: AgentSessionEvent): unknown {
    return {
      type: "iterate:agent:harness:pi:event-received",
      version: 1,
      createdAt: new Date().toISOString(),
      eventStreamId: agentPath,
      payload: {
        piEventType: piEvent.type,
        piEvent,
      },
    };
  }

  async loadSessions(): Promise<void> {
    if (!fs.existsSync(this.config.sessionsFile)) return;

    try {
      const content = fs.readFileSync(this.config.sessionsFile, "utf-8");
      const data = YAML.parse(content) as SessionsFile;
      if (!data?.sessions?.length) return;

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

  private saveSessions(): void {
    const sessions: SessionMapping[] = [];
    for (const [agentPath, state] of this.sessions.entries()) {
      sessions.push({
        agentPath,
        sessionFile: state.sessionFile,
        createdAt: new Date().toISOString(),
      });
    }

    try {
      fs.writeFileSync(this.config.sessionsFile, YAML.stringify({ sessions }), "utf-8");
    } catch (err) {
      console.error(`[Pi] Failed to save sessions file:`, err);
    }
  }

  private async restoreSession(agentPath: string, sessionFile: string): Promise<SessionState> {
    if (this.sessions.has(agentPath)) {
      return this.sessions.get(agentPath)!;
    }

    const authStorage = discoverAuthStorage();
    const modelRegistry = discoverModels(authStorage);
    const sessionManager = SessionManager.open(sessionFile);
    const { session } = await createAgentSession({
      sessionManager,
      authStorage,
      modelRegistry,
      cwd: this.cwd,
    });

    const unsubscribe = session.subscribe((piEvent: AgentSessionEvent) => {
      this.config.append(agentPath, this.wrapPiEvent(agentPath, piEvent));
    });

    const state: SessionState = { session, sessionManager, sessionFile, unsubscribe };
    this.sessions.set(agentPath, state);
    return state;
  }

  private async getOrCreateSession(agentPath: string): Promise<SessionState> {
    const existing = this.sessions.get(agentPath);
    if (existing) return existing;

    const authStorage = discoverAuthStorage();
    const modelRegistry = discoverModels(authStorage);
    const sessionManager = SessionManager.create(this.cwd);
    const { session } = await createAgentSession({
      sessionManager,
      authStorage,
      modelRegistry,
      cwd: this.cwd,
    });

    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("Session manager did not return a session file");
    }

    const unsubscribe = session.subscribe((piEvent: AgentSessionEvent) => {
      this.config.append(agentPath, this.wrapPiEvent(agentPath, piEvent));
    });

    const state: SessionState = { session, sessionManager, sessionFile, unsubscribe };
    this.sessions.set(agentPath, state);
    this.saveSessions();
    return state;
  }

  closeSession(agentPath: string): void {
    const state = this.sessions.get(agentPath);
    if (state) {
      state.unsubscribe();
      this.sessions.delete(agentPath);
      this.saveSessions();
    }
  }

  closeAll(): void {
    for (const agentPath of this.sessions.keys()) {
      this.closeSession(agentPath);
    }
  }
}
