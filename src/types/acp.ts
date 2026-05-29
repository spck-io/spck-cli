// Agent Client Protocol (ACP) message shapes.
// We pin a single protocol version; if `claude acp` later advertises a
// different version during `initialize`, AcpService surfaces a clear error
// instead of silently passing incompatible messages through.

export const ACP_PROTOCOL_VERSION = 1;

// JSON-RPC framing common to all ACP messages. Transport on the wire is
// newline-delimited JSON over the agent's stdio.
export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// --- client -> agent ---

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: Array<{ id: string; name: string; description?: string }>;
  // Some agents advertise the models they expose here.
  models?: Array<AcpModelInfo>;
}

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
}

export interface NewSessionParams {
  cwd: string;
  mcpServers?: Array<unknown>;
  // Non-standard but supported by Claude Code's ACP impl: pick model up-front.
  model?: string;
}

export interface NewSessionResult {
  sessionId: string;
  // Models the agent can switch to in this session (Claude Code extension).
  // Two shapes seen in the wild: a flat AcpModelInfo[], or claude-agent-acp's
  // `{ availableModels: [{modelId, name, description}], currentModelId }`.
  // Probe code in AcpService normalises both via normalizeModelsPayload().
  models?: AcpModelInfo[] | {
    availableModels: Array<{ modelId: string; name?: string; description?: string }>;
    currentModelId?: string;
  };
}

export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers?: Array<unknown>;
}

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface PromptResult {
  stopReason: 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | string;
}

export interface CancelParams {
  sessionId: string;
}

// Content blocks accepted by `session/prompt`. We only ever send `text`.
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string };

// --- agent -> client notifications ---

// `session/update` is the primary streaming channel. We forward each variant
// as-is to the browser client; the client transport adapter knows how to
// destructure it.
export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: 'pending' | 'in_progress' | 'completed' | 'failed';
      content?: Array<{ type: string; text?: string; path?: string }>;
      locations?: Array<{ path: string; line?: number }>;
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      status?: 'pending' | 'in_progress' | 'completed' | 'failed';
      content?: Array<{ type: string; text?: string; path?: string }>;
      rawOutput?: unknown;
    }
  | { sessionUpdate: 'plan'; entries: Array<PlanEntry> }
  | { sessionUpdate: 'available_commands_update'; availableCommands: unknown[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string };

export interface PlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status?: 'pending' | 'in_progress' | 'completed';
}

// --- agent -> client requests (require a response) ---

export interface ReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface ReadTextFileResult {
  content: string;
}

export interface WriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

// Empty result for write/permission acks.
export type WriteTextFileResult = null;

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    content?: Array<{ type: string; text?: string; path?: string }>;
    locations?: Array<{ path: string; line?: number }>;
    rawInput?: unknown;
  };
  options: Array<{
    optionId: string;
    name: string;
    kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
}

export interface RequestPermissionResult {
  outcome:
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' };
}

// --- model info (not a standard ACP message; surfaced via capabilities) ---

export interface AcpModelInfo {
  id: string;
  label: string;
  description?: string;
  default?: boolean;
}

// --- protocol error codes we care about ---

export const ACP_ERROR_AUTH_REQUIRED = -32000;
export const ACP_ERROR_UNSUPPORTED_VERSION = -32001;
