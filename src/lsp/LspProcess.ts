// JSON-RPC 2.0 over stdio with Content-Length framing — the wire format
// every LSP server (pyright-langserver, typescript-language-server, ...)
// uses. Composed by the bridges; not coupled to any specific server.

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

export interface LspProcessOptions {
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
  timer: NodeJS.Timeout;
};

export type NotificationHandler = (method: string, params: any) => void;

export class LspProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending: Map<number, Pending> = new Map();
  private notificationHandlers: NotificationHandler[] = [];
  private exited = false;
  private exitPromise: Promise<void>;
  private exitResolve!: () => void;

  private label: string;

  constructor(private opts: LspProcessOptions) {
    this.label = opts.name ?? opts.command;
    this.exitPromise = new Promise(resolve => { this.exitResolve = resolve; });
  }

  start(): void {
    if (this.proc) return;
    const proc = spawn(this.opts.command, this.opts.args || [], {
      cwd: this.opts.cwd,
      env: this.opts.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      // LSP servers commonly log to stderr; surface but don't fail.
      console.warn(`[lsp:${this.label}] ${chunk.toString().trimEnd()}`);
    });
    proc.on('exit', (code) => {
      this.exited = true;
      const err = new Error(`LSP process ${this.label} exited (code=${code})`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.exitResolve();
    });
    proc.on('error', (err) => {
      console.error(`[lsp:${this.label}] spawn error:`, err);
    });

    this.proc = proc;
  }

  isAlive(): boolean {
    return !!this.proc && !this.exited;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  // Send a request and wait for its response.
  async request<T = any>(method: string, params: any, timeoutMs = 30000): Promise<T> {
    if (!this.proc || this.exited) throw new Error('LSP process not running');
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(message);
    });
  }

  // Send a notification (no response expected).
  notify(method: string, params: any): void {
    if (!this.proc || this.exited) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  async stop(): Promise<void> {
    if (!this.proc || this.exited) return;
    try {
      this.notify('exit', null);
    } catch {}
    this.proc.kill();
    await this.exitPromise;
  }

  private write(msg: any): void {
    if (!this.proc) return;
    const json = JSON.stringify(msg);
    const body = Buffer.from(json, 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // malformed — drop everything up to and including the header break
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = parseInt(match[1], 10);
      const totalNeeded = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalNeeded) return;
      const body = this.buffer.slice(headerEnd + 4, totalNeeded).toString('utf8');
      this.buffer = this.buffer.slice(totalNeeded);
      this.dispatch(body);
    }
  }

  private dispatch(json: string): void {
    let msg: any;
    try {
      msg = JSON.parse(json);
    } catch (err) {
      console.error(`[lsp:${this.label}] failed to parse message:`, err);
      return;
    }
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'));
      else p.resolve(msg.result);
    } else if (msg.method) {
      // Notification (or server->client request — we don't service those)
      for (const h of this.notificationHandlers) {
        try { h(msg.method, msg.params); } catch (err) {
          console.error(`[lsp:${this.label}] notification handler error:`, err);
        }
      }
    }
  }
}
