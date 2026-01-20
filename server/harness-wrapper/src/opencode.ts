import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

interface SessionMapping {
  agentPath: string;
  sessionId: string;
  createdAt: string;
}

interface SessionsFile {
  sessions: SessionMapping[];
}

interface SessionState {
  client: OpencodeClient;
  sessionId: string;
  abortController: AbortController | null;
}

export interface OpenCodeAdapterConfig {
  append: (agentPath: string, event: unknown) => void;
  sessionsFile: string;
}

// OpenCode server URL - defaults to localhost:4096
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";

export class OpenCodeAdapter {
  private sessions = new Map<string, SessionState>();
  private config: OpenCodeAdapterConfig;
  private enabled: boolean;
  private baseUrl: string | null;

  constructor(config: OpenCodeAdapterConfig) {
    this.config = config;
    this.baseUrl = this.normalizeBaseUrl(OPENCODE_BASE_URL);
    this.enabled = !!this.baseUrl;

    if (!this.enabled) {
      console.log("[OpenCode] Adapter disabled - OPENCODE_BASE_URL not set or invalid");
    }

    const dir = path.dirname(config.sessionsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async on(agentPath: string, event: unknown): Promise<void> {
    if (!agentPath.startsWith("/opencode/")) return;
    if (!this.enabled) {
      console.log("[OpenCode] Skipping - adapter not enabled");
      return;
    }

    const content = this.extractUserMessageContent(event);
    if (!content) return;

    const state = await this.getOrCreateSession(agentPath);

    // Fire-and-forget so POST can return immediately.
    void this.sendPrompt(agentPath, state, content);
  }

  private extractUserMessageContent(event: unknown): string | null {
    if (typeof event !== "object" || event === null) return null;
    const e = event as { type?: string; payload?: { content?: string } };
    if (e.type === "iterate:agent:action:send-user-message:called" && e.payload?.content) {
      return e.payload.content;
    }
    return null;
  }

  private wrapOpenCodeEvent(agentPath: string, openCodeEvent: unknown): unknown {
    return {
      type: "iterate:agent:harness:opencode:event-received",
      version: 1,
      createdAt: new Date().toISOString(),
      eventStreamId: agentPath,
      payload: {
        openCodeEventType: (openCodeEvent as { type?: string }).type,
        openCodeEvent,
      },
    };
  }

  private async sendPrompt(agentPath: string, state: SessionState, content: string): Promise<void> {
    try {
      await state.client.session.prompt({
        path: { id: state.sessionId },
        body: {
          parts: [{ type: "text", text: content }],
        },
      });
    } catch (err) {
      console.error(`[OpenCode] Prompt failed for ${agentPath}:`, err);
    }
  }

  private normalizeBaseUrl(value?: string): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    try {
      const url = new URL(withScheme);
      return url.toString().replace(/\/+$/, "");
    } catch {
      console.error(`[OpenCode] Invalid OPENCODE_BASE_URL: "${value}"`);
      return null;
    }
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
          console.error(`[OpenCode] Failed to restore session for ${mapping.agentPath}:`, err);
        }
      }
    } catch (err) {
      console.error(`[OpenCode] Failed to load sessions file:`, err);
    }
  }

  private saveSessions(): void {
    const sessions: SessionMapping[] = [];
    for (const [agentPath, state] of this.sessions.entries()) {
      sessions.push({
        agentPath,
        sessionId: state.sessionId,
        createdAt: new Date().toISOString(),
      });
    }

    try {
      fs.writeFileSync(this.config.sessionsFile, YAML.stringify({ sessions }), "utf-8");
    } catch (err) {
      console.error(`[OpenCode] Failed to save sessions file:`, err);
    }
  }

  private async startEventStream(
    agentPath: string,
    client: OpencodeClient,
  ): Promise<AbortController> {
    const abortController = new AbortController();

    // Start streaming events in the background
    (async () => {
      try {
        const eventResult = await client.event.subscribe();
        for await (const event of eventResult.stream) {
          if (abortController.signal.aborted) break;
          this.config.append(agentPath, this.wrapOpenCodeEvent(agentPath, event));
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          console.error(`[OpenCode] Event stream error for ${agentPath}:`, err);
        }
      }
    })();

    return abortController;
  }

  private createClient(): OpencodeClient {
    if (!this.baseUrl) {
      throw new Error("OPENCODE_BASE_URL not set or invalid");
    }
    return createOpencodeClient({ baseUrl: this.baseUrl });
  }

  private async restoreSession(agentPath: string, sessionId: string): Promise<SessionState> {
    if (this.sessions.has(agentPath)) {
      return this.sessions.get(agentPath)!;
    }

    const client = this.createClient();
    const abortController = await this.startEventStream(agentPath, client);

    const state: SessionState = { client, sessionId, abortController };
    this.sessions.set(agentPath, state);
    return state;
  }

  private async getOrCreateSession(agentPath: string): Promise<SessionState> {
    const existing = this.sessions.get(agentPath);
    if (existing) return existing;

    const client = this.createClient();

    // Create a new session
    const sessionResult = await client.session.create();
    if (sessionResult.error || !sessionResult.data) {
      throw new Error(
        `Failed to create OpenCode session: ${JSON.stringify(sessionResult.error) ?? "Unknown error"}`,
      );
    }
    const sessionId = sessionResult.data.id;

    const abortController = await this.startEventStream(agentPath, client);

    const state: SessionState = { client, sessionId, abortController };
    this.sessions.set(agentPath, state);
    this.saveSessions();
    return state;
  }

  closeSession(agentPath: string): void {
    const state = this.sessions.get(agentPath);
    if (state) {
      state.abortController?.abort();
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
