/**
 * Terminal service - manages PTY sessions with xterm-headless
 */

import * as pty from 'node-pty';
import XtermHeadlessModule from '@xterm/headless';
import SerializeAddonModule from '@xterm/addon-serialize';
import { AuthenticatedSocket, ErrorCode, createRPCError } from '../types.js';
import { logTerminalRead, logTerminalWrite } from '../utils/logger.js';

const { Terminal: XtermHeadless } = XtermHeadlessModule as any;
const { SerializeAddon } = SerializeAddonModule as any;

interface TerminalSession {
  id: string;
  pty: pty.IPty;
  xterm: any;
  serializeAddon: any;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode?: number;
  uid: string;
  pendingWrites: number; // Track number of pending write operations
}

export class TerminalService {
  private sessions: Map<string, TerminalSession> = new Map();
  private activeTerminalId: string | null = null;

  constructor(
    private getSocket: () => AuthenticatedSocket,
    private maxTerminals: number = 10,
    private maxBufferedLines: number = 10000,
    private rootPath: string = process.cwd()
  ) {}

  /**
   * Get UID from socket with fallback
   */
  private getUid(): string {
    return this.getSocket().data?.uid || 'unknown';
  }

  /**
   * Handle terminal RPC methods
   */
  async handle(method: string, params: any): Promise<any> {
    const uid = this.getUid();
    let result: any;
    let error: any;

    // Define read and write operations
    const readOps = ['list', 'refresh'];
    const writeOps = ['create', 'destroy', 'activate', 'send', 'resize'];

    try {
      switch (method) {
        case 'create':
          result = await this.create(params);
          logTerminalWrite(method, params, uid, true, undefined, { terminalId: result });
          return result;
        case 'destroy':
          result = await this.destroy(params);
          logTerminalWrite(method, params, uid, true);
          return result;
        case 'activate':
          result = await this.activate(params);
          logTerminalWrite(method, params, uid, true);
          return result;
        case 'send':
          result = await this.send(params);
          logTerminalWrite(method, params, uid, true);
          return result;
        case 'resize':
          result = await this.resize(params);
          logTerminalWrite(method, params, uid, true);
          return result;
        case 'refresh':
          result = await this.refresh(params);
          logTerminalRead(method, params, uid, true);
          return result;
        case 'list':
          result = await this.list();
          logTerminalRead(method, params, uid, true, undefined, { count: result.length });
          return result;
        default:
          throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: terminal.${method}`);
      }
    } catch (err: any) {
      error = err;
      // Log error based on operation type
      if (readOps.includes(method)) {
        logTerminalRead(method, params, uid, false, error);
      } else if (writeOps.includes(method)) {
        logTerminalWrite(method, params, uid, false, error);
      }
      throw error;
    }
  }

  /**
   * Create new terminal session
   */
  private async create(params: { cols: number; rows: number }): Promise<string> {
    const uid = this.getUid();

    // Check terminal limit
    const userTerminals = Array.from(this.sessions.values()).filter((s) => s.uid === uid);

    if (userTerminals.length >= this.maxTerminals) {
      throw createRPCError(
        ErrorCode.TERMINAL_LIMIT_EXCEEDED,
        `Terminal limit exceeded (max ${this.maxTerminals})`
      );
    }

    const terminalId = this.generateId();

    // Auto-detect shell
    const shell =
      process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');

    // Spawn PTY process
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: params.cols || 80,
      rows: params.rows || 24,
      cwd: this.rootPath,
      env: process.env,
    });

    // Create headless xterm for buffer management
    const xterm = new XtermHeadless({
      cols: params.cols || 80,
      rows: params.rows || 24,
      scrollback: this.maxBufferedLines,
      allowProposedApi: true
    });

    const serializeAddon = new SerializeAddon();
    xterm.loadAddon(serializeAddon);

    // Connect PTY to xterm buffer
    ptyProcess.onData((data) => {
      const session = this.sessions.get(terminalId);
      if (session) {
        // Track pending write
        session.pendingWrites++;

        // Write to xterm with callback
        xterm.write(data, () => {
          // Decrement pending writes when complete
          if (session.pendingWrites > 0) {
            session.pendingWrites--;
          }
        });
      }

      // If this is the active terminal, stream to client
      if (this.activeTerminalId === terminalId) {
        this.getSocket().emit('rpc', {
          jsonrpc: '2.0',
          method: 'terminal.output',
          params: { terminalId, data },
        });
      }
    });

    // Handle process exit
    ptyProcess.onExit(({ exitCode }) => {
      const session = this.sessions.get(terminalId);
      if (session) {
        session.exited = true;
        session.exitCode = exitCode;

        // Notify client
        this.getSocket().emit('rpc', {
          jsonrpc: '2.0',
          method: 'terminal.exited',
          params: { terminalId, exitCode },
        });
      }
    });

    // Store session
    this.sessions.set(terminalId, {
      id: terminalId,
      pty: ptyProcess,
      xterm,
      serializeAddon,
      cols: params.cols || 80,
      rows: params.rows || 24,
      exited: false,
      uid,
      pendingWrites: 0,
    });

    // Send initial buffer
    await this.sendBufferRefresh(terminalId);

    return terminalId;
  }

  /**
   * Destroy terminal session
   */
  private async destroy(params: { terminalId: string }): Promise<void> {
    const session = this.sessions.get(params.terminalId);
    if (!session) {
      throw createRPCError(ErrorCode.TERMINAL_NOT_FOUND, 'Terminal not found');
    }

    // Verify ownership
    if (session.uid !== this.getUid()) {
      throw createRPCError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
    }

    // Kill PTY process if still running
    if (!session.exited) {
      session.pty.kill();
    }

    // Clean up
    this.sessions.delete(params.terminalId);

    if (this.activeTerminalId === params.terminalId) {
      this.activeTerminalId = null;
    }
  }

  /**
   * Activate terminal (start streaming)
   */
  private async activate(params: { terminalId: string }): Promise<void> {
    const session = this.sessions.get(params.terminalId);
    if (!session) {
      throw createRPCError(ErrorCode.TERMINAL_NOT_FOUND, 'Terminal not found');
    }

    // Verify ownership
    if (session.uid !== this.getUid()) {
      throw createRPCError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
    }

    // Update active terminal
    this.activeTerminalId = params.terminalId;

    // Send full buffer refresh
    await this.sendBufferRefresh(params.terminalId);
  }

  /**
   * Send input to terminal
   */
  private async send(params: { terminalId: string; data: string }): Promise<void> {
    const session = this.sessions.get(params.terminalId);
    if (!session) {
      throw createRPCError(ErrorCode.TERMINAL_NOT_FOUND, 'Terminal not found');
    }

    // Verify ownership
    if (session.uid !== this.getUid()) {
      throw createRPCError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
    }

    if (session.exited) {
      throw createRPCError(
        ErrorCode.TERMINAL_PROCESS_EXITED,
        'Terminal process has exited'
      );
    }

    // Write to PTY
    session.pty.write(params.data);
  }

  /**
   * Resize terminal
   */
  private async resize(params: { terminalId: string; cols: number; rows: number }): Promise<void> {
    const session = this.sessions.get(params.terminalId);
    if (!session) {
      throw createRPCError(ErrorCode.TERMINAL_NOT_FOUND, 'Terminal not found');
    }

    // Verify ownership
    if (session.uid !== this.getUid()) {
      throw createRPCError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
    }

    // Resize PTY
    session.pty.resize(params.cols, params.rows);

    // Resize xterm buffer
    session.xterm.resize(params.cols, params.rows);

    // Update session
    session.cols = params.cols;
    session.rows = params.rows;
  }

  /**
   * Refresh terminal buffer
   */
  private async refresh(params: { terminalId: string }): Promise<void> {
    const session = this.sessions.get(params.terminalId);
    if (!session) {
      throw createRPCError(ErrorCode.TERMINAL_NOT_FOUND, 'Terminal not found');
    }

    // Verify ownership
    if (session.uid !== this.getUid()) {
      throw createRPCError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
    }

    await this.sendBufferRefresh(params.terminalId);
  }

  /**
   * List terminals for current user
   */
  private async list(): Promise<string[]> {
    const uid = this.getUid();
    return Array.from(this.sessions.values())
      .filter((s) => s.uid === uid)
      .map((s) => s.id);
  }

  /**
   * Send buffer refresh notification
   */
  private async sendBufferRefresh(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    // Wait for pending writes to complete
    const waitForWrites = async () => {
      const maxWaitTime = 5000; // 5 seconds max
      const checkInterval = 10; // Check every 10ms
      let elapsed = 0;

      while (session.pendingWrites > 0 && elapsed < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        elapsed += checkInterval;
      }

      if (elapsed >= maxWaitTime) {
        console.warn(`Timeout waiting for pending writes (${session.pendingWrites} remaining)`);
      }
    };

    await waitForWrites();

    // Serialize xterm buffer
    const buffer = session.serializeAddon.serialize();
    console.log("buffer", buffer)
    // Send to client
    this.getSocket().emit('rpc', {
      jsonrpc: '2.0',
      method: 'terminal.bufferRefresh',
      params: { terminalId, buffer },
    });
  }

  /**
   * Generate unique terminal ID
   */
  private generateId(): string {
    return `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Cleanup all terminals
   */
  cleanup(): void {
    for (const session of this.sessions.values()) {
      if (!session.exited) {
        session.pty.kill();
      }
    }
    this.sessions.clear();
  }
}
