/**
 * Terminal service - manages PTY sessions with xterm-headless
 */

import * as pty from 'node-pty';
import { Terminal as XtermHeadless } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { AuthenticatedSocket, ErrorCode, createRPCError } from '../types';

interface TerminalSession {
  id: string;
  pty: pty.IPty;
  xterm: XtermHeadless;
  serializeAddon: SerializeAddon;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode?: number;
  uid: string;
}

export class TerminalService {
  private sessions: Map<string, TerminalSession> = new Map();
  private activeTerminalId: string | null = null;

  constructor(
    private socket: AuthenticatedSocket,
    private maxTerminals: number = 10,
    private maxBufferedLines: number = 10000,
    private rootPath: string = process.cwd()
  ) {}

  /**
   * Handle terminal RPC methods
   */
  async handle(method: string, params: any): Promise<any> {
    switch (method) {
      case 'create':
        return await this.create(params);
      case 'destroy':
        return await this.destroy(params);
      case 'activate':
        return await this.activate(params);
      case 'send':
        return await this.send(params);
      case 'resize':
        return await this.resize(params);
      case 'refresh':
        return await this.refresh(params);
      case 'list':
        return await this.list();
      default:
        throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: terminal.${method}`);
    }
  }

  /**
   * Create new terminal session
   */
  private async create(params: { cols: number; rows: number }): Promise<string> {
    const uid = this.socket.data.uid;

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
    });

    const serializeAddon = new SerializeAddon();
    xterm.loadAddon(serializeAddon);

    // Connect PTY to xterm buffer
    ptyProcess.onData((data) => {
      xterm.write(data);

      // If this is the active terminal, stream to client
      if (this.activeTerminalId === terminalId) {
        this.socket.emit('rpc', {
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
        this.socket.emit('rpc', {
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
    });

    // Send initial buffer
    this.sendBufferRefresh(terminalId);

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
    if (session.uid !== this.socket.data.uid) {
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
    if (session.uid !== this.socket.data.uid) {
      throw createRPCError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
    }

    // Update active terminal
    this.activeTerminalId = params.terminalId;

    // Send full buffer refresh
    this.sendBufferRefresh(params.terminalId);
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
    if (session.uid !== this.socket.data.uid) {
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
    if (session.uid !== this.socket.data.uid) {
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
    if (session.uid !== this.socket.data.uid) {
      throw createRPCError(ErrorCode.PERMISSION_DENIED, 'Permission denied');
    }

    this.sendBufferRefresh(params.terminalId);
  }

  /**
   * List terminals for current user
   */
  private async list(): Promise<string[]> {
    const uid = this.socket.data.uid;
    return Array.from(this.sessions.values())
      .filter((s) => s.uid === uid)
      .map((s) => s.id);
  }

  /**
   * Send buffer refresh notification
   */
  private sendBufferRefresh(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    // Serialize xterm buffer
    const buffer = session.serializeAddon.serialize();

    // Send to client
    this.socket.emit('rpc', {
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
