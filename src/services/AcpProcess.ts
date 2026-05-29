// Subprocess wrapper for ACP agents (e.g. `claude acp`).
//
// ACP frames messages as newline-delimited JSON over stdio — one JSON object
// per line, both directions. (Distinct from LSP, which uses Content-Length
// framing — that's why this isn't shared with LspProcess.)
//
// The agent is bidirectional: it sends notifications (session/update),
// requests we must answer (fs/read_text_file, session/request_permission),
// and replies to the requests we send (initialize, session/new, etc.).
// `onNotification` and `onRequest` handlers expose those two directions.

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { JsonRpcMessage } from '../types/acp.js';

export interface AcpProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  // Display name used in log messages (defaults to command basename).
  name?: string;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout | null;
};

export type NotificationHandler = (method: string, params: any) => void;
// Request handlers return a result (resolved as the response) or throw a
// JSON-RPC-shaped error. Resolving with undefined sends `result: null`.
export type RequestHandler = (method: string, params: any) => Promise<unknown>;

export class AcpProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer: string = '';
  private nextId = 1;
  private pending: Map<number, Pending> = new Map();
  private notificationHandlers: NotificationHandler[] = [];
  private requestHandler: RequestHandler | null = null;
  private exited = false;
  private exitPromise: Promise<void>;
  private exitResolve!: () => void;
  private label: string;

  constructor(private opts: AcpProcessOptions) {
    this.label = opts.name ?? opts.command;
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  start(): void {
    if (this.proc) return;
    const proc = spawn(this.opts.command, this.opts.args || [], {
      cwd: this.opts.cwd,
      env: this.opts.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      // Claude Code logs progress to stderr; surface but don't fail.
      console.warn(`[acp:${this.label}] ${chunk.toString().trimEnd()}`);
    });
    proc.on('exit', (code) => {
      this.exited = true;
      const err = new Error(`ACP process ${this.label} exited (code=${code})`);
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.exitResolve();
    });
    proc.on('error', (err) => {
      console.error(`[acp:${this.label}] spawn error:`, err);
    });

    this.proc = proc;
  }

  isAlive(): boolean {
    return !!this.proc && !this.exited;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  // Single request handler — replaces any prior one. Owners typically set this
  // once after spawn to dispatch fs/* and session/request_permission.
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  // `timeoutMs = 0` means "no timeout" — used for session/prompt, which legitimately
  // takes minutes (tool loops, long reasoning) and is cancelled out-of-band via
  // session/cancel rather than via the request promise rejecting.
  async request<T = any>(method: string, params: unknown, timeoutMs = 60000): Promise<T> {
    if (!this.proc || this.exited) throw new Error(`ACP process not running: ${this.label}`);
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`ACP request timed out: ${method}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this.write(message);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.proc || this.exited) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  async stop(): Promise<void> {
    if (!this.proc || this.exited) return;
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    // Give it a moment, then force-kill.
    const timer = setTimeout(() => {
      try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
    await this.exitPromise;
    clearTimeout(timer);
  }

  private write(msg: JsonRpcMessage): void {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.error(`[acp:${this.label}] failed to parse message:`, line.slice(0, 200));
      return;
    }
    if (typeof msg.method === 'string') {
      // Agent->client: notification (no id) or request (id present)
      if (msg.id != null) {
        this.handleAgentRequest(msg);
        return;
      }
      for (const h of this.notificationHandlers) {
        try {
          h(msg.method, msg.params);
        } catch (err) {
          console.error(`[acp:${this.label}] notification handler error:`, err);
        }
      }
      return;
    }
    // Response to one of our outgoing requests.
    if (msg.id != null) {
      const numericId = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const p = this.pending.get(numericId);
      if (!p) return;
      this.pending.delete(numericId);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        const err: Error & { code?: number; data?: unknown } = new Error(
          msg.error.message || `ACP error ${msg.error.code}`
        );
        err.code = msg.error.code;
        err.data = msg.error.data;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private async handleAgentRequest(msg: JsonRpcMessage): Promise<void> {
    if (!this.requestHandler) {
      this.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not handled: ${msg.method}` },
      });
      return;
    }
    try {
      const result = await this.requestHandler(msg.method!, msg.params);
      this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (err: any) {
      this.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: err?.code ?? -32603,
          message: err?.message ?? 'internal error',
        },
      });
    }
  }
}
