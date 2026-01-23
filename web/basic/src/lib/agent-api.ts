/** User message mode - controls how the message affects in-flight responses */
export type UserMessageMode = "interrupt" | "queue" | "background";

/** Event envelope for user messages sent to agents */
export interface UserMessageEvent {
  type: "iterate:agent:action:send-user-message:called";
  version: 1;
  createdAt?: string; // Optional - server will set if not provided
  eventStreamId: string;
  payload: { content: string; mode?: UserMessageMode };
}

/** Event to cancel the current request */
export interface CancelRequestEvent {
  type: "iterate:agent:action:cancel-request:called";
  version: 1;
  eventStreamId: string;
  payload: Record<string, never>;
}

/** Result of an API operation */
export interface ApiResult {
  ok: boolean;
  error?: string;
}

/**
 * Build the full URL for an agent endpoint.
 * Agent paths should start with "/" (e.g., "/pi/my-session").
 */
export function buildAgentURL(apiURL: string, agentPath: string): string {
  // Ensure path starts with /
  const normalizedPath = agentPath.startsWith("/") ? agentPath : `/${agentPath}`;
  // Encode each segment while preserving the path structure
  const encodedPath = normalizedPath
    .split("/")
    .map((segment) => (segment ? encodeURIComponent(segment) : ""))
    .join("/");
  return new URL(`/agents${encodedPath}`, apiURL).toString();
}

/** Create a user message event envelope (createdAt is set by server) */
export function createMessageEvent(
  agentPath: string,
  text: string,
  mode?: UserMessageMode,
): UserMessageEvent {
  return {
    type: "iterate:agent:action:send-user-message:called",
    version: 1,
    eventStreamId: agentPath,
    payload: mode ? { content: text, mode } : { content: text },
  };
}

/** Create a cancel request event */
export function createCancelEvent(agentPath: string): CancelRequestEvent {
  return {
    type: "iterate:agent:action:cancel-request:called",
    version: 1,
    eventStreamId: agentPath,
    payload: {},
  };
}

/** Send raw JSON to an agent endpoint */
export async function sendRawJson(
  apiURL: string,
  agentPath: string,
  jsonString: string,
): Promise<ApiResult> {
  try {
    const res = await fetch(buildAgentURL(apiURL, agentPath), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: jsonString,
    });
    if (!res.ok) {
      return { ok: false, error: `Server error: ${res.status} ${res.statusText}` };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed";
    return { ok: false, error: message };
  }
}

/** Send a user message to an agent (wrapped in event envelope) */
export async function sendMessage(
  apiURL: string,
  agentPath: string,
  text: string,
  mode?: UserMessageMode,
): Promise<ApiResult> {
  const event = createMessageEvent(agentPath, text, mode);
  return sendRawJson(apiURL, agentPath, JSON.stringify(event, null, 2));
}

/** Send a cancel request to stop the current response */
export async function sendCancelRequest(apiURL: string, agentPath: string): Promise<ApiResult> {
  const event = createCancelEvent(agentPath);
  return sendRawJson(apiURL, agentPath, JSON.stringify(event));
}

/** Audio input event for voice agents */
export interface AudioInputEvent {
  type: "iterate:agent:action:send-user-audio:called";
  version: 1;
  eventStreamId: string;
  payload: { audio: string }; // base64 PCM s16le 48kHz
}

/** Create an audio input event envelope */
export function createAudioEvent(agentPath: string, audioBase64: string): AudioInputEvent {
  return {
    type: "iterate:agent:action:send-user-audio:called",
    version: 1,
    eventStreamId: agentPath,
    payload: { audio: audioBase64 },
  };
}

/** Send audio to an agent (wrapped in event envelope) */
export async function sendAudio(
  apiURL: string,
  agentPath: string,
  audioBase64: string,
): Promise<ApiResult> {
  const event = createAudioEvent(agentPath, audioBase64);
  return sendRawJson(apiURL, agentPath, JSON.stringify(event));
}

/**
 * Normalize an agent path input to just the session name.
 * Strips any prefixes like "#", "agents/", "/pi/", "pi/".
 * Returns the clean session name without path prefix.
 */
export function normalizeAgentPath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const normalized = trimmed
    .replace(/^#/, "")
    .replace(/^\/?agents\//, "")
    .replace(/^\/?pi\//, "")
    .replace(/^\//, "");

  return normalized || null;
}

/**
 * Encode an agent path for use in URL hash.
 * Always returns a path starting with "/" (e.g., "/pi/my-session" or "/my-session").
 */
export function encodeAgentPath(sessionName: string, options?: { prefix?: string }): string {
  const encoded = encodeURIComponent(sessionName);
  if (options?.prefix) {
    // Ensure prefix starts with /
    const normalizedPrefix = options.prefix.startsWith("/") ? options.prefix : `/${options.prefix}`;
    return `${normalizedPrefix}${encoded}`;
  }
  return `/${encoded}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Supported AI model types */
export type AiModelType = "openai" | "grok";

/** Config event for setting AI model */
export interface ConfigSetEvent {
  type: "iterate:agent:config:set";
  version: 1;
  eventStreamId: string;
  payload: { model: AiModelType };
}

/** Create a config event for setting the AI model */
export function createConfigEvent(agentPath: string, model: AiModelType): ConfigSetEvent {
  return {
    type: "iterate:agent:config:set",
    version: 1,
    eventStreamId: agentPath,
    payload: { model },
  };
}

/** Send a config event to set the AI model */
export async function sendConfigEvent(
  apiURL: string,
  agentPath: string,
  model: AiModelType,
): Promise<ApiResult> {
  const event = createConfigEvent(agentPath, model);
  return sendRawJson(apiURL, agentPath, JSON.stringify(event));
}

/** Check if an agent path is a PI agent path */
export function isPiAgentPath(agentPath: string): boolean {
  return agentPath.startsWith("/pi/");
}

/** Extract the session name from an agent path */
export function getSessionName(agentPath: string): string {
  return agentPath
    .replace(/^\/?pi\//, "")
    .replace(/^\/?claude\//, "")
    .replace(/^\/?opencode\//, "")
    .replace(/^\//, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness Type Detection
// ─────────────────────────────────────────────────────────────────────────────

/** Available harness types */
export type HarnessType = "pi" | "claude" | "opencode" | null;

/** All harness prefixes */
const HARNESS_PREFIXES: Record<Exclude<HarnessType, null>, string> = {
  pi: "/pi/",
  claude: "/claude/",
  opencode: "/opencode/",
};

/** Detect harness type from an agent path */
export function detectHarnessType(agentPath: string): HarnessType {
  if (agentPath.startsWith("/pi/")) return "pi";
  if (agentPath.startsWith("/claude/")) return "claude";
  if (agentPath.startsWith("/opencode/")) return "opencode";
  return null;
}

/** Get the URL prefix for a harness type */
export function getHarnessPrefix(type: HarnessType): string {
  if (!type) return "/";
  return HARNESS_PREFIXES[type];
}

/** Strip any harness prefix from an agent path */
export function stripHarnessPrefix(agentPath: string): string {
  const harnessType = detectHarnessType(agentPath);
  if (!harnessType) return agentPath.replace(/^\//, "");
  return agentPath.slice(HARNESS_PREFIXES[harnessType].length);
}
