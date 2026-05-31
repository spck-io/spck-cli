/**
 * JSON-RPC 2.0 request router
 */

import * as path from 'path';
import { AuthenticatedSocket, JSONRPCRequest, ErrorCode, createRPCError, ToolDetectionResult } from '../types.js';
import { FilesystemService } from '../services/FilesystemService.js';
import { GitService } from '../services/GitService.js';
import { TerminalService } from '../services/TerminalService.js';
import { SearchService } from '../services/SearchService.js';
import { BrowserProxyService } from '../services/BrowserProxyService.js';
import { LanguageServerService } from '../services/LanguageServerService.js';
import { AcpService } from '../services/AcpService.js';
import { FileWatcher } from '../watcher/FileWatcher.js';

export class RPCRouter {
  private static filesystemService: FilesystemService;
  private static gitService: GitService;
  private static searchService: SearchService;
  private static terminalServices: Map<string, TerminalService> = new Map();
  private static currentSockets: Map<string, AuthenticatedSocket> = new Map();
  private static browserProxyService: BrowserProxyService;
  private static languageServerService: LanguageServerService;
  private static acpService: AcpService | undefined;
  private static rootPath: string;
  private static tools: ToolDetectionResult;
  private static terminalEnabled: boolean;
  private static browserProxyEnabled: boolean;
  private static languageServerEnabled: boolean;
  private static acpEnabled: boolean;
  private static fileWatcher: FileWatcher | null = null;
  private static broadcastCallback: ((method: string, params: any) => void) | null = null;

  /**
   * Initialize services
   */
  static initialize(rootPath: string, config: any, tools: ToolDetectionResult) {
    this.rootPath = rootPath;
    this.tools = tools;
    this.terminalEnabled = config.terminal?.enabled ?? true;
    this.browserProxyEnabled = config.browserProxy?.enabled ?? true;
    this.languageServerEnabled = config.languageServer?.enabled ?? true;
    // ACP is opt-out per project. Default true for back-compat with configs
    // that predate the toggle. When disabled, we don't construct the service
    // at all — `acp.*` RPCs reject with FEATURE_DISABLED below, and the
    // client's transport-switcher falls back to the cloud (SSE) path.
    this.acpEnabled = config.acp?.enabled ?? true;
    this.filesystemService = new FilesystemService(rootPath, config.filesystem);
    this.gitService = new GitService(rootPath);
    this.browserProxyService = new BrowserProxyService();
    this.languageServerService = new LanguageServerService(rootPath, {
      enabled: this.languageServerEnabled,
      typescript: config.languageServer?.typescript,
      python: config.languageServer?.python,
    });
    if (this.acpEnabled) {
      this.acpService = new AcpService({ rootPath });
    }

    // Parse maxFileSize from config
    const maxFileSizeBytes = this.parseFileSize(config.filesystem.maxFileSize);
    this.searchService = new SearchService(rootPath, maxFileSizeBytes, 64 * 1024, tools.ripgrep);

    this.startFileWatcher(rootPath);
  }

  /**
   * Register a callback that broadcasts JSON-RPC notifications to all connected clients.
   * Called by ProxyClient once it is ready to accept connections.
   */
  static setBroadcastCallback(fn: (method: string, params: any) => void): void {
    this.broadcastCallback = fn;
    // AcpService streams session/update notifications back through the same
    // broadcast channel as fs.change events.
    this.acpService?.setBroadcast(fn);
  }

  /**
   * Shut down the file watcher. Called on graceful disconnect.
   */
  static cleanup(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    this.broadcastCallback = null;
    this.acpService?.cleanup().catch(() => null);
  }

  private static startFileWatcher(rootPath: string): void {
    this.fileWatcher = new FileWatcher(rootPath, [
      '**/.git/**',
      '**/.spck-editor/**',
      '**/node_modules/**',
    ]);

    this.fileWatcher.on('change', (filePath: string) => {
      const rel = '/' + path.relative(rootPath, filePath);
      this.broadcastFileChange(rel, 'write');
    });

    this.fileWatcher.on('added', (filePath: string) => {
      const rel = '/' + path.relative(rootPath, filePath);
      this.broadcastFileChange(rel, 'write');
    });

    this.fileWatcher.on('removed', (filePath: string) => {
      const rel = '/' + path.relative(rootPath, filePath);
      this.broadcastFileChange(rel, 'remove');
    });
  }

  private static broadcastFileChange(filePath: string, action: string): void {
    if (this.broadcastCallback) {
      this.broadcastCallback('fs.change', { path: filePath, action });
    }
  }

  /**
   * Parse file size string to bytes
   */
  private static parseFileSize(sizeStr: string): number {
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
    if (!match) {
      return 10 * 1024 * 1024; // Default 10MB
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();

    const multipliers: { [key: string]: number } = {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
    };

    return value * multipliers[unit];
  }

  /**
   * Get or create terminal service for socket
   */
  private static getTerminalService(socket: AuthenticatedSocket): TerminalService {
    const deviceId = socket.data.deviceId;

    // Update current socket for this deviceId (handles reconnections)
    this.currentSockets.set(deviceId, socket);

    if (!this.terminalServices.has(deviceId)) {
      // Create new service with getter function that returns current socket
      const getSocket = () => {
        const currentSocket = this.currentSockets.get(deviceId);
        if (!currentSocket) {
          throw new Error(`No active socket for device: ${deviceId}`);
        }
        return currentSocket;
      };
      this.terminalServices.set(deviceId, new TerminalService(getSocket, 10, 10000, this.rootPath));
    }

    return this.terminalServices.get(deviceId)!;
  }

  /**
   * Route JSON-RPC request to appropriate service
   */
  static async route(
    message: JSONRPCRequest,
    socket: AuthenticatedSocket
  ): Promise<any> {
    const { method, params } = message;

    // Parse method prefix (split on first dot only so sub-namespaces like browser.proxy.request are preserved)
    const dotIndex = method.indexOf('.');
    const service = dotIndex !== -1 ? method.slice(0, dotIndex) : method;
    const methodName = dotIndex !== -1 ? method.slice(dotIndex + 1) : '';

    if (!service || !methodName) {
      throw createRPCError(
        ErrorCode.INVALID_REQUEST,
        `Invalid method format: ${method}`
      );
    }

    try {
      switch (service) {
        case 'fs':
          return await this.filesystemService.handle(methodName, params, socket);

        case 'git':
          if (!this.tools.git) {
            throw createRPCError(
              ErrorCode.FEATURE_DISABLED,
              'Git is not available. Install Git 2.20.0+ to use version control features.'
            );
          }
          return await this.gitService.handle(methodName, params, socket);

        case 'search':
          // Search is always available, but fast search (ripgrep) may be disabled
          return await this.searchService.handle(methodName, params, socket);

        case 'terminal':
          if (!this.terminalEnabled) {
            throw createRPCError(
              ErrorCode.FEATURE_DISABLED,
              'Terminal is disabled in configuration.'
            );
          }
          const terminalService = this.getTerminalService(socket);
          return await terminalService.handle(methodName, params);

        case 'lsp':
          // Service handles its own enabled-gating so `lsp.capabilities` can
          // always answer (client uses it to decide whether to fall back).
          return await this.languageServerService.handle(methodName, params, socket);

        case 'browser': {
          if (!this.browserProxyEnabled) {
            throw createRPCError(
              ErrorCode.FEATURE_DISABLED,
              'Browser proxy is disabled in configuration.'
            );
          }
          // methodName is 'proxy.request' — strip the 'proxy.' sub-namespace
          const dotIdx = methodName.indexOf('.');
          const browserMethod = dotIdx !== -1 ? methodName.slice(dotIdx + 1) : methodName;
          return await this.browserProxyService.handle(browserMethod, params, socket);
        }

        case 'acp':
          // Project-level kill switch. When `config.acp.enabled` is false we
          // never construct the service, and the transport-switcher in the
          // client expects `acp.capabilities` to answer with available:false
          // so it can fall back to the SSE path. Other acp.* methods reject
          // with FEATURE_DISABLED so a misbehaving client gets a clear error
          // rather than a 'Method not found'.
          if (!this.acpService) {
            if (methodName === 'capabilities') return { available: false, agents: [] };
            throw createRPCError(
              ErrorCode.FEATURE_DISABLED,
              'ACP is disabled in this project\'s configuration.'
            );
          }
          return await this.acpService.handle(methodName, params, socket);

        default:
          throw createRPCError(
            ErrorCode.METHOD_NOT_FOUND,
            `Unknown service: ${service}`
          );
      }
    } catch (error: any) {
      // Re-throw if already an RPC error
      if (error.code && error.message) {
        throw error;
      }

      // Wrap other errors
      console.error(`Error in ${method}:`, error);
      throw createRPCError(
        ErrorCode.INTERNAL_ERROR,
        `Internal error: ${error.message || 'Unknown error'}`,
        { method, originalError: error.toString() }
      );
    }
  }

  /**
   * Cleanup terminal service for socket
   */
  static cleanupTerminalService(socket: AuthenticatedSocket) {
    const deviceId = socket.data.deviceId;
    const service = this.terminalServices.get(deviceId);
    if (service) {
      service.cleanup();
      this.terminalServices.delete(deviceId);
      this.currentSockets.delete(deviceId);
    }
  }

  /**
   * Kill any ACP subprocesses owned by this socket. Called from the same
   * disconnect path as cleanupTerminalService.
   */
  static cleanupAcpSessions(socket: AuthenticatedSocket): void {
    this.acpService?.cleanupSocket(socket).catch(() => null);
  }
}
