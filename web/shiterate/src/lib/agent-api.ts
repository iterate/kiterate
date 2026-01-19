/** Event envelope for user messages sent to agents */
export interface UserMessageEvent {
  type: "iterate:agent:action:send-user-message:called";
  version: 1;
  createdAt: string;
  eventStreamId: string;
  payload: { content: string };
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

/** Create a user message event envelope */
export function createMessageEvent(agentPath: string, text: string): UserMessageEvent {
  return {
    type: "iterate:agent:action:send-user-message:called",
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId: agentPath,
    payload: { content: text },
  };
}

/** Send raw JSON to an agent endpoint */
export async function sendRawJson(
  apiURL: string,
  agentPath: string,
  jsonString: string
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
  text: string
): Promise<ApiResult> {
  const event = createMessageEvent(agentPath, text);
  return sendRawJson(apiURL, agentPath, JSON.stringify(event, null, 2));
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

/** Check if an agent path is a PI agent path */
export function isPiAgentPath(agentPath: string): boolean {
  return agentPath.startsWith("/pi/");
}

/** Extract the session name from an agent path */
export function getSessionName(agentPath: string): string {
  return agentPath.replace(/^\/?pi\//, "").replace(/^\//, "");
}
