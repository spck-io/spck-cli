/**
 * JSON-RPC 2.0 request router
 */

import { AuthenticatedSocket, JSONRPCRequest, ErrorCode, createRPCError } from '../types';
import { FilesystemService } from '../services/FilesystemService';
import { GitService } from '../services/GitService';
import { TerminalService } from '../services/TerminalService';

export class RPCRouter {
  private static filesystemService: FilesystemService;
  private static gitService: GitService;
  private static terminalServices: Map<string, TerminalService> = new Map();

  /**
   * Initialize services
   */
  static initialize(rootPath: string, config: any) {
    this.filesystemService = new FilesystemService(rootPath, config.filesystem);
    this.gitService = new GitService(rootPath);
  }

  /**
   * Get or create terminal service for socket
   */
  private static getTerminalService(socket: AuthenticatedSocket): TerminalService {
    const uid = socket.data.uid;
    if (!this.terminalServices.has(uid)) {
      this.terminalServices.set(uid, new TerminalService(socket));
    }
    return this.terminalServices.get(uid)!;
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
          return await this.gitService.handle(methodName, params, socket);

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
    const uid = socket.data.uid;
    const service = this.terminalServices.get(uid);
    if (service) {
      service.cleanup();
      this.terminalServices.delete(uid);
    }
  }
}
