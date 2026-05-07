// `lsp.*` RPC handler. capabilities is always answered (even when disabled)
// so the client can decide to fall back without an RPC error round-trip.

import * as path from 'path';
import { AuthenticatedSocket, ErrorCode, createRPCError } from '../types.js';
import { LspBridge, LscRequest } from '../lsp/LspBridge.js';
import { createPyrightBridge } from '../lsp/PyrightBridge.js';
import { createTsServerBridge } from '../lsp/TsServerBridge.js';
import { logLsp } from '../utils/logger.js';

export interface LanguageServerConfig {
  enabled: boolean;
  // Optional disables per language (e.g., user has no Python toolchain).
  typescript?: boolean;
  python?: boolean;
}

export class LanguageServerService {
  private tsBridge: LspBridge | null = null;
  private pyBridge: LspBridge | null = null;
  private capabilities: { enabled: boolean; modes: string[]; methods: string[] };

  constructor(private rootPath: string, private cfg: LanguageServerConfig) {
    const modes: string[] = [];
    if (cfg.enabled && cfg.typescript !== false) {
      modes.push('typescript', 'javascript', 'jsx', 'tsx');
    }
    if (cfg.enabled && cfg.python !== false) {
      modes.push('python');
    }
    this.capabilities = {
      enabled: !!cfg.enabled && modes.length > 0,
      modes,
      methods: [
        'setCurrentDirectory', 'add', 'edit', 'update', 'remove', 'removeFolder',
        'move', 'moveFolder', 'clear',
        'completion', 'info', 'signature', 'validate', 'def', 'ref', 'rename', 'renameInfo',
      ],
    };
  }

  async handle(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    // `capabilities` always answers — the client uses it to detect whether
    // remote LSP is available. Other methods require enabled=true.
    if (method === 'capabilities') return this.capabilities;
    if (!this.cfg.enabled) {
      throw createRPCError(ErrorCode.FEATURE_DISABLED, 'Language server is disabled in configuration.');
    }
    const uid = socket.data.deviceId ?? '';
    switch (method) {
      case 'message': {
        const req = params as LscRequest;
        try {
          const result = await this.handleLscMessage(req);
          logLsp(method, req, uid, true);
          return result;
        } catch (err: any) {
          logLsp(method, req, uid, false, err);
          throw err;
        }
      }
      default:
        throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: lsp.${method}`);
    }
  }

  private async handleLscMessage(req: LscRequest): Promise<LscRequest> {
    const bridge = this.bridgeFor(req);
    if (!bridge) {
      // No bridge for this mode — mark missing so the client falls back.
      const isQuery = ['completion', 'info', 'signature', 'validate', 'def', 'ref', 'rename', 'renameInfo']
        .some(t => t === req.type || (req.types || []).includes(t));
      if (isQuery) req.missing = true;
      return req;
    }
    return bridge.handleMessage(req);
  }

  private bridgeFor(req: LscRequest): LspBridge | null {
    const ext = req.name ? path.extname(req.name).toLowerCase() : '';
    if (ext === '.py' || ext === '.pyi') {
      if (this.cfg.python === false) return null;
      if (!this.pyBridge) this.pyBridge = createPyrightBridge(this.rootPath);
      return this.pyBridge;
    }
    if (this.tsExts.has(ext)) {
      if (this.cfg.typescript === false) return null;
      if (!this.tsBridge) this.tsBridge = createTsServerBridge(this.rootPath);
      return this.tsBridge;
    }
    return null;
  }

  private tsExts = new Set([
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  ]);

  async cleanup(): Promise<void> {
    await Promise.allSettled([
      this.tsBridge?.stop(),
      this.pyBridge?.stop(),
    ]);
  }
}
