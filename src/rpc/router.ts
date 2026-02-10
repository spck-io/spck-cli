/**
 * JSON-RPC 2.0 request router
 */

import { AuthenticatedSocket, JSONRPCRequest, ErrorCode, createRPCError, ToolDetectionResult } from '../types.js';
import { FilesystemService } from '../services/FilesystemService.js';
import { GitService } from '../services/GitService.js';
import { TerminalService } from '../services/TerminalService.js';
import { SearchService } from '../services/SearchService.js';

export class RPCRouter {
  private static filesystemService: FilesystemService;
  private static gitService: GitService;
  private static searchService: SearchService;
  private static terminalServices: Map<string, TerminalService> = new Map();
  private static currentSockets: Map<string, AuthenticatedSocket> = new Map();
  private static rootPath: string;
  private static tools: ToolDetectionResult;

  /**
   * Initialize services
   */
  static initialize(rootPath: string, config: any, tools: ToolDetectionResult) {
    this.rootPath = rootPath;
    this.tools = tools;
    this.filesystemService = new FilesystemService(rootPath, config.filesystem);
    this.gitService = new GitService(rootPath);

    // Parse maxFileSize from config
    const maxFileSizeBytes = this.parseFileSize(config.filesystem.maxFileSize);
    this.searchService = new SearchService(rootPath, maxFileSizeBytes, 64 * 1024, tools.ripgrep);
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

    // Parse method prefix
    const [service, methodName] = method.split('.');

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
          const terminalService = this.getTerminalService(socket);
          return await terminalService.handle(methodName, params);

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
}
