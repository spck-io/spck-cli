// `acp.*` RPC handler — owns `claude acp` (or compatible) subprocesses, one
// per active chat. Sessions are keyed by the client's `chatId` for stable
// addressing; the actual ACP `sessionId` returned by the agent is stashed
// internally.
//
// Streaming session/update notifications go back to the client via the
// existing RPCRouter.broadcastCallback mechanism (same pattern fs.change
// uses). Server-initiated requests (session/request_permission) use the
// socket.emit/socket.on('rpc') pattern from GitService.requestAuth.

import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveAcpAgents, type ResolvedAgent } from '../utils/acp-agents.js';
import { AuthenticatedSocket, ErrorCode, createRPCError } from '../types.js';
import { AcpProcess } from './AcpProcess.js';
import { logAcp } from '../utils/logger.js';
import {
  ACP_PROTOCOL_VERSION,
  ACP_ERROR_AUTH_REQUIRED,
  AcpConfigOption,
  AcpModelInfo,
  InitializeResult,
  NewSessionResult,
  SessionUpdateNotification,
} from '../types/acp.js';

export type { ResolvedAgent } from '../utils/acp-agents.js';

type BroadcastFn = (method: string, params: any) => void;

interface PendingPermission {
  responseHandler: (response: any) => void;
  resolve: (value: unknown) => void;
  socket: AuthenticatedSocket;
}

interface ManagedSession {
  chatId: string;
  agentSessionId: string;
  agentName: string;
  agentBinary: string;
  cwd: string;
  model: string | null;
  proc: AcpProcess;
  // Socket that owns this session — used for server-initiated permission
  // requests. Sessions are torn down when the owning socket disconnects.
  socket: AuthenticatedSocket;
  // Outstanding session/request_permission promises, keyed by the id we sent
  // to the client. Drained on cancel/teardown so the agent never hangs.
  pendingPermissions: Map<number, PendingPermission>;
  // True while a session/prompt RPC is in flight to the agent. Guards against
  // a second concurrent prompt on the same chatId — the agent's stdio can't
  // safely interleave two outstanding session/prompt requests, and the second
  // would resolve against the wrong response.
  promptInFlight: boolean;
  // Single shared 'disconnect' listener has been wired for the owning socket.
  // Idempotency guard — see ensureSocketTeardown.
  socketTeardownWired: boolean;
}

export interface AcpServiceOptions {
  rootPath: string;
  // Override for tests; defaults to probing the built-in registry on PATH.
  resolveAgents?: () => ResolvedAgent[];
}

export class AcpService {
  private sessions: Map<string, ManagedSession> = new Map();
  private cachedCapabilities: {
    available: boolean;
    agents: Array<{ name: string; version: string; models: AcpModelInfo[] }>;
  } | null = null;
  // Resolved agent registry by name — populated alongside capabilities() so
  // newSession()/setModel() can look up the binary for a chosen model.
  private agentRegistry: Map<string, ResolvedAgent> = new Map();
  private broadcast: BroadcastFn | null = null;
  private rootPath: string;
  private resolveAgents: () => ResolvedAgent[];
  // Monotonic id for outbound acp.requestPermission requests. Random ids
  // could collide if two prompts overlap on the same socket and the wrong
  // promise would resolve.
  private nextPermissionId = 1;

  constructor(opts: AcpServiceOptions) {
    this.rootPath = opts.rootPath;
    this.resolveAgents = opts.resolveAgents ?? resolveAcpAgents;
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  async handle(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    const uid = socket.data.deviceId ?? '';
    try {
      const result = await this.dispatch(method, params, socket);
      // Skip noisy success log for `prompt` — the agent streams session/update
      // notifications throughout the turn; one more line per prompt-completion
      // is redundant. (Failures still log below.)
      if (method !== 'prompt' && method !== 'respondPermission') {
        logAcp(`acp.${method}`, params || {}, uid, true);
      }
      return result;
    } catch (err: any) {
      logAcp(`acp.${method}`, params || {}, uid, false, err);
      throw err;
    }
  }

  private async dispatch(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    switch (method) {
      case 'capabilities':
        // `refresh: true` re-probes PATH so the client can pick up agents
        // installed after cli startup without restarting the host.
        return this.capabilities({ refresh: params?.refresh === true });
      case 'newSession':
        return this.newSession(params, socket);
      case 'setModel':
        return this.setModel(params, socket);
      case 'prompt':
        return this.prompt(params);
      case 'cancel':
        return this.cancel(params);
      case 'closeSession':
        return this.closeSession(params);
      case 'respondPermission':
        // No-op at this layer — the actual delivery happens via the
        // socket.emit('rpc') roundtrip in `requestPermission`. Clients that
        // want to proactively send a decision use this method as an
        // acknowledgement; we accept and discard.
        return null;
      default:
        throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: acp.${method}`);
    }
  }

  // --- capabilities ---

  async capabilities(opts: { refresh?: boolean } = {}): Promise<{
    available: boolean;
    agents: Array<{ name: string; version: string; models: AcpModelInfo[] }>;
  }> {
    if (this.cachedCapabilities && !opts.refresh) return this.cachedCapabilities;
    if (opts.refresh) this.cachedCapabilities = null;
    const resolved = this.resolveAgents();
    this.agentRegistry.clear();
    for (const agent of resolved) this.agentRegistry.set(agent.name, agent);
    if (!resolved.length) {
      this.cachedCapabilities = { available: false, agents: [] };
      return this.cachedCapabilities;
    }
    // Probe each agent in parallel. An agent failing to advertise models is
    // not fatal — surface it with an empty models array so the user still
    // sees it exists but can't pick a model.
    const probed = await Promise.all(
      resolved.map(async (agent) => {
        const models = await this.probeAgentModels(agent).catch((err) => {
          console.warn(`[acp] failed to probe ${agent.name} models:`, err?.message ?? err);
          return [] as AcpModelInfo[];
        });
        // Tag each model with its agent name so the client can disambiguate
        // models that share an id across agents (e.g. both claude and codex
        // exposing a `default` alias).
        const tagged = models.map((m) => ({ ...m, agent: agent.name } as AcpModelInfo & { agent: string }));
        return { name: agent.name, version: agent.version, models: tagged };
      })
    );
    this.cachedCapabilities = {
      available: probed.some((a) => a.models.length > 0),
      agents: probed,
    };
    return this.cachedCapabilities;
  }

  // Look up which resolved agent owns a model id. When no id is provided
  // we pick the first probed agent as the default. When a specific id is
  // provided but doesn't match any agent, return null so the caller can
  // surface a real error instead of silently routing to the wrong agent.
  private agentForModel(modelId: string | null | undefined): ResolvedAgent | null {
    if (!this.cachedCapabilities) return null;
    if (modelId) {
      for (const a of this.cachedCapabilities.agents) {
        if (a.models.some((m) => m.id === modelId)) {
          return this.agentRegistry.get(a.name) ?? null;
        }
      }
      return null;
    }
    const first = this.cachedCapabilities.agents[0];
    return first ? this.agentRegistry.get(first.name) ?? null : null;
  }

  private async probeAgentModels(agent: ResolvedAgent): Promise<AcpModelInfo[]> {
    const proc = new AcpProcess({
      command: agent.binary,
      args: agent.args,
      cwd: this.rootPath,
      name: `${agent.name}-probe`,
    });
    proc.start();
    try {
      const init = await proc.request<InitializeResult>(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        },
        10000
      );
      const fromInit = normalizeModelsPayload(init?.models);
      if (fromInit.length) return fromInit;
      // claude-agent-acp (and likely other Claude-SDK-backed agents) doesn't
      // advertise its model catalogue in `initialize`; it ships them in the
      // `session/new` response instead. Open a throwaway session so the
      // dropdown can populate. The process is killed in the outer finally
      // block, which tears down the session along with it.
      const session = await proc.request<NewSessionResult>(
        'session/new',
        { cwd: this.rootPath, mcpServers: [] },
        15000
      );
      return modelsFromSession(session);
    } finally {
      await proc.stop().catch(() => null);
    }
  }

  // --- session lifecycle ---

  async newSession(
    params: { chatId: string; cwd?: string; model?: string | null },
    socket: AuthenticatedSocket
  ): Promise<{ sessionId: string; models: AcpModelInfo[]; defaultModel: string | null }> {
    if (!params?.chatId) {
      throw createRPCError(ErrorCode.INVALID_PARAMS, 'chatId is required');
    }
    const existing = this.sessions.get(params.chatId);
    // Idempotent re-use, BUT only when the caller hasn't asked for a different
    // model. If they explicitly passed a model that doesn't match the live
    // session's, the only correct behaviour is to recreate — silently returning
    // the old session would leave the agent wired to the old model even though
    // the chat thinks the switch took effect.
    const requestedModel = params.model ?? null;
    const modelMatches = requestedModel == null || requestedModel === existing?.model;
    if (existing && existing.proc.isAlive() && modelMatches) {
      // Rebind to the caller's socket — ACP sessions persist across client
      // disconnects so the user can resume. Without this, the session.socket
      // still points at the prior (dead) socket and the agent's permission
      // requests would emit to nowhere. socketTeardownWired is reset so the
      // next permission attaches a 'disconnect' handler on the *new* socket.
      existing.socket = socket;
      existing.socketTeardownWired = false;
      const ownerAgent = this.cachedCapabilities?.agents.find((a) => a.name === existing.agentName);
      return {
        sessionId: existing.agentSessionId,
        models: ownerAgent?.models ?? [],
        defaultModel: existing.model,
      };
    }
    if (existing) {
      await this.closeSessionInternal(params.chatId);
    }

    // Ensure the registry is populated before model→agent lookup.
    if (!this.cachedCapabilities) await this.capabilities();
    const agent = this.agentForModel(params.model ?? null);
    if (!agent) {
      throw createRPCError(
        ErrorCode.FEATURE_DISABLED,
        params.model
          ? `No ACP agent advertises model "${params.model}"`
          : 'No ACP agent available on this host'
      );
    }

    const cwd = params.cwd ? this.resolveCwd(params.cwd) : this.rootPath;
    const session = await this.spawnSession({
      chatId: params.chatId,
      cwd,
      model: params.model ?? null,
      agent,
      socket,
    });
    const ownerAgent = this.cachedCapabilities?.agents.find((a) => a.name === agent.name);
    return {
      sessionId: session.agentSessionId,
      models: ownerAgent?.models ?? [],
      defaultModel: session.model,
    };
  }

  private async spawnSession(args: {
    chatId: string;
    cwd: string;
    model: string | null;
    agent: ResolvedAgent;
    socket: AuthenticatedSocket;
  }): Promise<ManagedSession> {
    const proc = new AcpProcess({
      command: args.agent.binary,
      args: args.agent.args,
      cwd: args.cwd,
      name: `${args.agent.name}:${args.chatId.slice(-8)}`,
    });
    proc.start();

    // Forward notifications immediately, before initialize, in case the agent
    // begins emitting status. Most agents stay quiet until session/prompt,
    // but be defensive.
    proc.onNotification((method, params) => this.onAgentNotification(args.chatId, method, params));
    proc.onRequest((method, params) => this.onAgentRequest(args.chatId, method, params));

    const init = await proc.request<InitializeResult>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    // Per ACP spec the agent may reply with a lower protocolVersion when it
    // can't speak ours; the client must close rather than pretend.
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      await proc.stop().catch(() => null);
      throw createRPCError(
        ErrorCode.FEATURE_DISABLED,
        `ACP agent advertised protocolVersion ${init?.protocolVersion}, expected ${ACP_PROTOCOL_VERSION}`
      );
    }

    const newSessionParams: any = { cwd: args.cwd, mcpServers: [] };
    if (args.model) newSessionParams.model = args.model;
    let result: NewSessionResult;
    try {
      result = await proc.request<NewSessionResult>('session/new', newSessionParams);
      // Current agents expose model selection through configOptions. Passing
      // `model` to session/new alone is ignored by these agents.
      const modelOption = findModelConfigOption(result.configOptions);
      if (args.model && modelOption && modelOption.currentValue !== args.model) {
        await proc.request('session/set_config_option', {
          sessionId: result.sessionId,
          configId: modelOption.id,
          value: args.model,
        });
      }
    } catch (err: any) {
      await proc.stop().catch(() => null);
      if (err?.code === ACP_ERROR_AUTH_REQUIRED) {
        throw createRPCError(
          ErrorCode.AUTHENTICATION_FAILED,
          `ACP agent requires authentication; run \`${args.agent.binary} login\` and retry`
        );
      }
      throw err;
    }

    const session: ManagedSession = {
      chatId: args.chatId,
      agentSessionId: result.sessionId,
      agentName: args.agent.name,
      agentBinary: args.agent.binary,
      cwd: args.cwd,
      model: args.model,
      proc,
      socket: args.socket,
      pendingPermissions: new Map(),
      promptInFlight: false,
      socketTeardownWired: false,
    };
    this.sessions.set(args.chatId, session);
    return session;
  }

  async setModel(
    params: { chatId: string; model: string },
    socket: AuthenticatedSocket
  ): Promise<{ sessionId: string }> {
    const session = this.requireSession(params.chatId);
    if (session.model === params.model) {
      return { sessionId: session.agentSessionId };
    }
    // Recreate the session under the same chatId to support cross-agent
    // switches; the client is responsible for replaying
    // history if needed (or accepting a cold start). Cross-agent switches
    // (e.g. claude -> codex) are supported because the target agent is
    // resolved from the model id, not pinned to the previous session.
    await this.closeSessionInternal(params.chatId);
    if (!this.cachedCapabilities) await this.capabilities();
    const agent = this.agentForModel(params.model);
    if (!agent) {
      throw createRPCError(
        ErrorCode.FEATURE_DISABLED,
        `No ACP agent advertises model "${params.model}"`
      );
    }
    const fresh = await this.spawnSession({
      chatId: params.chatId,
      cwd: session.cwd,
      model: params.model,
      agent,
      socket,
    });
    return { sessionId: fresh.agentSessionId };
  }

  async prompt(params: { chatId: string; content: string }): Promise<{ stopReason: string } & Record<string, unknown>> {
    const session = this.requireSession(params.chatId);
    // Reject a second prompt for a chat that already has one in flight.
    // Queuing two session/prompts on the same agent stdio is undefined
    // behaviour; the client UI gates this too but the server is the
    // authoritative defence (covers racy submits and clients that bypass
    // the stop-button guard). The `reason` field on data is the typed
    // channel the client matches on — keep it stable.
    if (session.promptInFlight) {
      throw createRPCError(
        ErrorCode.FEATURE_DISABLED,
        `Chat ${params.chatId} has a turn already in flight`,
        { reason: 'prompt_busy' }
      );
    }
    session.promptInFlight = true;
    try {
      // Pass the whole result through. ACP only standardizes `stopReason`, but
      // agents commonly attach `_meta` / `usage` so the client can render token
      // accounting; forwarding the full object lets us evolve without churning
      // this layer each time the agent's payload grows a field.
      // No timeout: a real prompt easily runs minutes (tool loops, long reasoning,
      // bash subprocesses). Cancellation is out-of-band via session/cancel (the
      // client's stop button). Agent death still rejects the pending request via
      // AcpProcess's exit handler.
      const result = await session.proc.request<{ stopReason: string } & Record<string, unknown>>(
        'session/prompt',
        {
          sessionId: session.agentSessionId,
          prompt: [{ type: 'text', text: params.content }],
        },
        0
      );
      return result;
    } finally {
      session.promptInFlight = false;
    }
  }

  async cancel(params: { chatId: string }): Promise<null> {
    const session = this.sessions.get(params.chatId);
    if (!session) return null;
    session.proc.notify('session/cancel', { sessionId: session.agentSessionId });
    // ACP spec: any in-flight session/request_permission must be answered
    // with {outcome: 'cancelled'} after we send session/cancel.
    this.drainPendingPermissions(session);
    // Do NOT clear promptInFlight here. The agent must reply to the
    // outstanding session/prompt (with stopReason='cancelled') and the
    // prompt()'s try/finally clears the flag once the RPC settles. Clearing
    // eagerly would let a follow-up prompt fire while the previous
    // session/prompt is still pending on the agent's stdio — exactly the
    // race the flag exists to prevent. If an agent is so broken it never
    // replies to its own cancel, the recovery path is closeSession +
    // newSession (forced respawn) rather than weakening the invariant.
    return null;
  }

  async closeSession(params: { chatId: string }): Promise<null> {
    await this.closeSessionInternal(params.chatId);
    return null;
  }

  private async closeSessionInternal(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;
    this.sessions.delete(chatId);
    this.drainPendingPermissions(session);
    await session.proc.stop().catch(() => null);
  }

  // Resolve every pending permission promise with `cancelled` and detach the
  // socket listeners. Called from cancel/teardown so the agent process can
  // finish its turn and we don't leak listeners on the socket.
  private drainPendingPermissions(session: ManagedSession): void {
    for (const pending of session.pendingPermissions.values()) {
      try {
        pending.socket.off('rpc', pending.responseHandler);
      } catch {
        // ignore
      }
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    session.pendingPermissions.clear();
  }

  // --- agent -> client message forwarding ---

  private onAgentNotification(chatId: string, method: string, params: any): void {
    if (method !== 'session/update') {
      // Unknown notifications are surfaced as-is so future ACP additions don't
      // get silently dropped.
      this.emit('acp.update', { chatId, method, params });
      return;
    }
    const payload = params as SessionUpdateNotification;
    this.emit('acp.update', { chatId, method: 'session/update', params: payload });
  }

  private async onAgentRequest(chatId: string, method: string, params: any): Promise<unknown> {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`Unknown chat: ${chatId}`);

    switch (method) {
      case 'fs/read_text_file':
        return this.handleReadTextFile(session, params);
      case 'fs/write_text_file':
        return this.handleWriteTextFile(session, params);
      case 'session/request_permission':
        return this.requestPermission(session, params);
      default:
        // Unknown agent request — surface to client so it can extend later.
        // Default behavior: reject so the agent doesn't hang.
        throw new Error(`Unsupported agent method: ${method}`);
    }
  }

  private async handleReadTextFile(
    session: ManagedSession,
    params: any
  ): Promise<{ content: string }> {
    const abs = this.resolveSessionPath(session, params?.path);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // ACP RESOURCE_NOT_FOUND — distinct code so the agent can react.
        const e: Error & { code?: number } = new Error(`File not found: ${params?.path}`);
        e.code = -32002;
        throw e;
      }
      throw err;
    }
    if (typeof params?.line === 'number' || typeof params?.limit === 'number') {
      const lines = content.split('\n');
      const start = Math.max(0, (params.line ?? 1) - 1);
      const end = typeof params.limit === 'number' ? start + params.limit : lines.length;
      content = lines.slice(start, end).join('\n');
    }
    return { content };
  }

  private async handleWriteTextFile(session: ManagedSession, params: any): Promise<null> {
    const abs = this.resolveSessionPath(session, params?.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, params?.content ?? '', 'utf8');
    return null;
  }

  // Bridge ACP's session/request_permission to the spck client. We reuse the
  // git.requestAuth pattern: emit a server-initiated `rpc` request, await the
  // matching response. No timeout — the user may take their time. The session
  // wires a single 'disconnect' listener per socket (see ensureSocketTeardown
  // below) that drains every pending permission for that session, so we don't
  // need to attach a per-request disconnect handler and trip Node's
  // MaxListenersExceededWarning on tool-heavy turns.
  private async requestPermission(session: ManagedSession, params: any): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = this.nextPermissionId++;
      const socket = session.socket;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        session.pendingPermissions.delete(requestId);
        try { socket.off('rpc', responseHandler); } catch { /* ignore */ }
        fn();
      };
      const responseHandler = (response: any) => {
        if (!response || response.id !== requestId) return;
        if (response.error) {
          finish(() => reject(new Error(response.error.message)));
        } else {
          finish(() => resolve(response.result));
        }
      };
      session.pendingPermissions.set(requestId, {
        responseHandler,
        socket,
        resolve: (value) => finish(() => resolve(value)),
      });
      this.ensureSocketTeardown(session);
      socket.on('rpc', responseHandler);
      socket.emit('rpc', {
        jsonrpc: '2.0',
        id: requestId,
        method: 'acp.requestPermission',
        params: {
          chatId: session.chatId,
          ...params,
        },
      });
    });
  }

  // Attach (at most once per current owner socket) a single 'disconnect'
  // listener that drains pending permissions THIS socket issued — replacing
  // the prior per-request listener that consolidated into one source of
  // MaxListenersExceededWarning under tool-heavy turns. Idempotency is
  // tracked via socketTeardownWired, which newSession resets to false when
  // it rebinds the session to a new socket (multi-tab reconnect). The
  // listener captures the owner socket and drains only permissions whose
  // `pending.socket === owner`, so a stale owner disappearing can't cancel
  // permissions issued by the current owner.
  private ensureSocketTeardown(session: ManagedSession): void {
    if (session.socketTeardownWired) return;
    session.socketTeardownWired = true;
    const owner = session.socket;
    owner.on('disconnect', () => {
      for (const [id, pending] of Array.from(session.pendingPermissions)) {
        if (pending.socket !== owner) continue;
        try { pending.socket.off('rpc', pending.responseHandler); } catch { /* ignore */ }
        pending.resolve({ outcome: { outcome: 'cancelled' } });
        session.pendingPermissions.delete(id);
      }
    });
  }

  // --- helpers ---

  private requireSession(chatId: string): ManagedSession {
    const session = this.sessions.get(chatId);
    if (!session || !session.proc.isAlive()) {
      throw createRPCError(
        ErrorCode.INTERNAL_ERROR,
        `No active ACP session for chat ${chatId}`
      );
    }
    return session;
  }

  // True when `child` is `root` or strictly nested under it. A raw
  // `startsWith` would falsely accept sibling directories that share the
  // root's name as a prefix (e.g. `/proj/foo-extra` vs root `/proj/foo`).
  private isWithinRoot(child: string, root: string): boolean {
    if (child === root) return true;
    return child.startsWith(root + path.sep);
  }

  private resolveCwd(input: string): string {
    // Always resolve cwd against the cli's rootPath. ACP sessions are
    // sandboxed to the project the cli is serving.
    const abs = path.resolve(this.rootPath, input);
    if (!this.isWithinRoot(abs, path.resolve(this.rootPath))) {
      throw createRPCError(ErrorCode.INVALID_PATH, `cwd outside project root: ${input}`);
    }
    return abs;
  }

  private resolveSessionPath(session: ManagedSession, requested: unknown): string {
    if (typeof requested !== 'string' || !requested) {
      throw createRPCError(ErrorCode.INVALID_PARAMS, 'path is required');
    }
    const abs = path.resolve(session.cwd, requested);
    if (!this.isWithinRoot(abs, path.resolve(this.rootPath))) {
      throw createRPCError(ErrorCode.INVALID_PATH, `path outside project root: ${requested}`);
    }
    return abs;
  }

  private emit(method: string, params: any): void {
    if (this.broadcast) this.broadcast(method, params);
  }

  // --- lifecycle ---

  async cleanupSocket(socket: AuthenticatedSocket): Promise<void> {
    const toClose: string[] = [];
    for (const [chatId, session] of this.sessions) {
      if (session.socket === socket) toClose.push(chatId);
    }
    await Promise.allSettled(toClose.map((id) => this.closeSessionInternal(id)));
  }

  async cleanup(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.allSettled(ids.map((id) => this.closeSessionInternal(id)));
  }
}

// Current agents expose model selectors through session configOptions.
function findModelConfigOption(options?: AcpConfigOption[]): AcpConfigOption | undefined {
  return options?.find((o) => o.type === 'select' && o.category === 'model')
    ?? options?.find((o) => o.type === 'select' && o.id === 'model');
}

function modelsFromSession(session: NewSessionResult): AcpModelInfo[] {
  const option = findModelConfigOption(session.configOptions);
  if (option) {
    const values = (option.options ?? []).flatMap((entry) => 'group' in entry ? entry.options : [entry]);
    const models = values.map((entry) => normalizeModelEntry({
      id: entry.value,
      name: entry.name,
      description: entry.description,
    }, typeof option.currentValue === 'string' ? option.currentValue : null))
      .filter((model): model is AcpModelInfo => model !== null);
    if (models.length) return models;
  }
  return normalizeModelsPayload(session.models);
}

// Legacy agents expose a flat array or an availableModels/currentModelId object.
function normalizeModelsPayload(payload: unknown): AcpModelInfo[] {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload
      .map((m) => normalizeModelEntry(m))
      .filter((m): m is AcpModelInfo => m !== null);
  }
  if (typeof payload === 'object') {
    const obj = payload as { availableModels?: unknown; currentModelId?: unknown };
    if (Array.isArray(obj.availableModels)) {
      const currentId = typeof obj.currentModelId === 'string' ? obj.currentModelId : null;
      return obj.availableModels
        .map((m) => normalizeModelEntry(m, currentId))
        .filter((m): m is AcpModelInfo => m !== null);
    }
  }
  return [];
}

function normalizeModelEntry(raw: unknown, currentModelId: string | null = null): AcpModelInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // claude-agent-acp uses `modelId`/`name`; the older flat shape uses `id`/`label`.
  const id = typeof r.id === 'string' ? r.id : typeof r.modelId === 'string' ? r.modelId : null;
  if (!id) return null;
  const label = typeof r.label === 'string' ? r.label : typeof r.name === 'string' ? r.name : id;
  const description = typeof r.description === 'string' ? r.description : undefined;
  const isDefault = currentModelId != null ? id === currentModelId : Boolean(r.default);
  const out: AcpModelInfo = { id, label };
  if (description) out.description = description;
  if (isDefault) out.default = true;
  return out;
}
