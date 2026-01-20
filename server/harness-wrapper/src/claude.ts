import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import YAML from "yaml";
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

interface SessionMapping {
  agentPath: string;
  sessionId: string;
  createdAt: string;
}

interface SessionsFile {
  sessions: SessionMapping[];
}

type ClaudeSession = ReturnType<typeof unstable_v2_createSession>;

interface SessionState {
  session: ClaudeSession;
  sessionId: string | null;
}

export interface ClaudeAdapterConfig {
  append: (agentPath: string, event: unknown) => void;
  sessionsFile: string;
}

function isClaudeCodeAvailable(): boolean {
  try {
    // Check if claude is in PATH
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export class ClaudeAdapter {
  private sessions = new Map<string, SessionState>();
  private config: ClaudeAdapterConfig;
  private model = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5-20250929";
  private enabled: boolean;

  constructor(config: ClaudeAdapterConfig) {
    this.config = config;
    this.enabled = isClaudeCodeAvailable();

    if (!this.enabled) {
      console.log("[Claude] Adapter disabled - Claude Code CLI not found in PATH");
    }

    const dir = path.dirname(config.sessionsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async on(agentPath: string, event: unknown): Promise<void> {
    if (!agentPath.startsWith("/claude/")) return;
    if (!this.enabled) {
      console.log("[Claude] Skipping - adapter not enabled");
      return;
    }

    const content = this.extractUserMessageContent(event);
    if (!content) return;

    const state = await this.getOrCreateSession(agentPath);
    await state.session.send(content);

    // Stream response and wrap each event
    for await (const msg of state.session.stream()) {
      // Capture session_id from first message for persistence
      if (!state.sessionId && msg.session_id) {
        state.sessionId = msg.session_id;
        this.saveSessions();
      }
      this.config.append(agentPath, this.wrapClaudeEvent(agentPath, msg));
    }
  }

  private extractUserMessageContent(event: unknown): string | null {
    if (typeof event !== "object" || event === null) return null;
    const e = event as { type?: string; payload?: { content?: string } };
    if (e.type === "iterate:agent:action:send-user-message:called" && e.payload?.content) {
      return e.payload.content;
    }
    return null;
  }

  private wrapClaudeEvent(agentPath: string, claudeEvent: SDKMessage): unknown {
    return {
      type: "iterate:agent:harness:claude:event-received",
      version: 1,
      createdAt: new Date().toISOString(),
      eventStreamId: agentPath,
      payload: {
        claudeEventType: claudeEvent.type,
        claudeSessionId: claudeEvent.session_id,
        claudeEvent,
      },
    };
  }

  async loadSessions(): Promise<void> {
    if (!this.enabled) return;
    if (!fs.existsSync(this.config.sessionsFile)) return;

    try {
      const content = fs.readFileSync(this.config.sessionsFile, "utf-8");
      const data = YAML.parse(content) as SessionsFile;
      if (!data?.sessions?.length) return;

      for (const mapping of data.sessions) {
        try {
          await this.restoreSession(mapping.agentPath, mapping.sessionId);
        } catch (err) {
          console.error(`[Claude] Failed to restore session for ${mapping.agentPath}:`, err);
        }
      }
    } catch (err) {
      console.error(`[Claude] Failed to load sessions file:`, err);
    }
  }

  private saveSessions(): void {
    const sessions: SessionMapping[] = [];
    for (const [agentPath, state] of this.sessions.entries()) {
      if (state.sessionId) {
        sessions.push({
          agentPath,
          sessionId: state.sessionId,
          createdAt: new Date().toISOString(),
        });
      }
    }

    try {
      fs.writeFileSync(this.config.sessionsFile, YAML.stringify({ sessions }), "utf-8");
    } catch (err) {
      console.error(`[Claude] Failed to save sessions file:`, err);
    }
  }

  private async restoreSession(agentPath: string, sessionId: string): Promise<SessionState> {
    if (this.sessions.has(agentPath)) {
      return this.sessions.get(agentPath)!;
    }

    const session = unstable_v2_resumeSession(sessionId, { model: this.model });
    const state: SessionState = { session, sessionId };
    this.sessions.set(agentPath, state);
    return state;
  }

  private async getOrCreateSession(agentPath: string): Promise<SessionState> {
    const existing = this.sessions.get(agentPath);
    if (existing) return existing;

    const session = unstable_v2_createSession({ model: this.model });
    const state: SessionState = { session, sessionId: null };
    this.sessions.set(agentPath, state);
    // Note: sessionId will be captured from first streamed message
    return state;
  }

  closeSession(agentPath: string): void {
    const state = this.sessions.get(agentPath);
    if (state) {
      state.session.close();
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
