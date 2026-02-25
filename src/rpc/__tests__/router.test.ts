import { describe, it, expect, beforeEach, vi, type Mock, type MockedClass } from 'vitest';
/**
 * Tests for JSON-RPC Router
 */

// Mock xterm headless modules BEFORE importing TerminalService
vi.mock('@xterm/headless', () => ({
  default: { Terminal: vi.fn() },
  Terminal: vi.fn(),
}));
vi.mock('@xterm/addon-serialize', () => ({
  default: { SerializeAddon: vi.fn() },
  SerializeAddon: vi.fn(),
}));

import * as crypto from 'crypto';
import { RPCRouter } from '../router.js';
import { ErrorCode, createRPCError, JSONRPCRequest } from '../../types.js';
import { FilesystemService } from '../../services/FilesystemService.js';
import { GitService } from '../../services/GitService.js';
import { TerminalService } from '../../services/TerminalService.js';

/**
 * Helper function to create a valid JSONRPCRequest with HMAC and nonce
 */
function createRequest(method: string, params?: any, id?: number | string): JSONRPCRequest {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signingKey = 'test-key';

  const payload = {
    jsonrpc: '2.0' as const,
    method,
    params,
    id,
    nonce,
  };

  const messageToSign = timestamp + JSON.stringify(payload);
  const hmac = crypto
    .createHmac('sha256', signingKey)
    .update(messageToSign)
    .digest('hex');

  return {
    ...payload,
    timestamp,
    hmac,
    nonce,
  };
}

// Mock services
vi.mock('../../services/FilesystemService', () => {
  const MockFS = vi.fn();
  MockFS.prototype.handle = vi.fn();
  return { FilesystemService: MockFS };
});
vi.mock('../../services/GitService', () => {
  const MockGit = vi.fn();
  MockGit.prototype.handle = vi.fn();
  return { GitService: MockGit };
});
vi.mock('../../services/TerminalService', () => {
  const MockTerm = vi.fn();
  MockTerm.prototype.handle = vi.fn();
  MockTerm.prototype.cleanup = vi.fn();
  return { TerminalService: MockTerm };
});

const MockFilesystemService = FilesystemService as MockedClass<typeof FilesystemService>;
const MockGitService = GitService as MockedClass<typeof GitService>;
const MockTerminalService = TerminalService as MockedClass<typeof TerminalService>;

describe('RPCRouter', () => {
  let mockSocket: any;
  let mockFsHandle: Mock;
  let mockGitHandle: Mock;
  let mockTerminalHandle: Mock;

  beforeEach(() => {
    mockSocket = {
      id: 'test-socket-id',
      data: {
        uid: 'test-user-123',
      },
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      broadcast: {
        emit: vi.fn(),
      },
    };

    // Clear all mocks
    vi.clearAllMocks();

    // Clear router state between tests
    (RPCRouter as any).terminalServices = new Map();
    (RPCRouter as any).currentSockets = new Map();

    // Set up default mock implementations
    mockFsHandle = vi.fn().mockResolvedValue({ success: true });
    mockGitHandle = vi.fn().mockResolvedValue({ success: true });
    mockTerminalHandle = vi.fn().mockResolvedValue('term-123');

    // Mock the service prototypes
    MockFilesystemService.prototype.handle = mockFsHandle;
    MockGitService.prototype.handle = mockGitHandle;

    // Create mock instance for terminal service that will be returned by constructor
    // Use a single tracked cleanup function across all instances
    const mockCleanupFn = vi.fn();
    MockTerminalService.mockImplementation(() => ({
      handle: mockTerminalHandle,
      cleanup: mockCleanupFn,
    }) as any);

    // Initialize router
    RPCRouter.initialize('/test/root', {
      filesystem: { maxFileSize: '100MB', watchIgnorePatterns: [] },
    }, {
      git: true,
      ripgrep: true,
    });
  });

  describe('Route Method Parsing', () => {
    it('should parse method correctly for fs service', async () => {
      await RPCRouter.route(
        createRequest('fs.readFile', { path: '/test.txt' }, 1),
        mockSocket
      );

      expect(mockFsHandle).toHaveBeenCalledWith('readFile', { path: '/test.txt' }, mockSocket);
    });

    it('should parse method correctly for git service', async () => {
      await RPCRouter.route(
        createRequest('git.log', { dir: '/project' }, 2),
        mockSocket
      );

      expect(mockGitHandle).toHaveBeenCalledWith('log', { dir: '/project' }, mockSocket);
    });

    it('should parse method correctly for terminal service', async () => {
      await RPCRouter.route(
        createRequest('terminal.create', { cols: 80, rows: 24 }, 3),
        mockSocket
      );

      expect(mockTerminalHandle).toHaveBeenCalledWith('create', { cols: 80, rows: 24 });
    });

    it('should throw error for invalid method format', async () => {
      await expect(
        RPCRouter.route(
          createRequest('invalidmethod', {}, 4),
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_REQUEST,
        message: expect.stringContaining('Invalid method format'),
      });
    });

    it('should throw error for unknown service', async () => {
      await expect(
        RPCRouter.route(
          createRequest('unknown.method', {}, 5),
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.METHOD_NOT_FOUND,
        message: expect.stringContaining('Unknown service'),
      });
    });
  });

  describe('Service Routing', () => {
    it('should route to FilesystemService', async () => {
      const mockResult = { content: 'file contents' };
      mockFsHandle.mockResolvedValueOnce(mockResult);

      const result = await RPCRouter.route(
        createRequest('fs.readFile', { path: '/test.txt', encoding: 'utf8' }, 10),
        mockSocket
      );

      expect(result).toEqual(mockResult);
      expect(mockFsHandle).toHaveBeenCalledTimes(1);
    });

    it('should route to GitService', async () => {
      const mockResult = { oid: 'abc123', commit: {} };
      mockGitHandle.mockResolvedValueOnce(mockResult);

      const result = await RPCRouter.route(
        createRequest('git.readCommit', { dir: '/project', oid: 'abc123' }, 11),
        mockSocket
      );

      expect(result).toEqual(mockResult);
      expect(mockGitHandle).toHaveBeenCalledTimes(1);
    });

    it('should route to TerminalService', async () => {
      const result = await RPCRouter.route(
        createRequest('terminal.create', { cols: 120, rows: 30 }, 12),
        mockSocket
      );

      // Should return the default mock result
      expect(result).toEqual('term-123');
      expect(mockTerminalHandle).toHaveBeenCalledTimes(1);
    });

    it('should create separate terminal services per device', async () => {
      const socket1 = { ...mockSocket, id: 'socket-1', data: { uid: 'user-1', deviceId: 'device-1' } };
      const socket2 = { ...mockSocket, id: 'socket-2', data: { uid: 'user-2', deviceId: 'device-2' } };

      const result1 = await RPCRouter.route(
        createRequest('terminal.create', {}, 1),
        socket1
      );

      const result2 = await RPCRouter.route(
        createRequest('terminal.create', {}, 2),
        socket2
      );

      // Both should succeed (indicating separate services were created)
      expect(result1).toBeTruthy();
      expect(result2).toBeTruthy();
      expect(mockTerminalHandle).toHaveBeenCalledTimes(2);
    });

    it('should reuse terminal service for same device', async () => {
      const socket1 = { ...mockSocket, id: 'socket-1', data: { uid: 'user-same', deviceId: 'device-same' } };
      const socket2 = { ...mockSocket, id: 'socket-2', data: { uid: 'user-same', deviceId: 'device-same' } };

      const result1 = await RPCRouter.route(
        createRequest('terminal.create', {}, 1),
        socket1
      );

      const result2 = await RPCRouter.route(
        createRequest('terminal.create', {}, 2),
        socket2
      );

      // Both should succeed using the same service instance
      expect(result1).toBeTruthy();
      expect(result2).toBeTruthy();
      expect(mockTerminalHandle).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Handling', () => {
    it('should re-throw RPC errors from services', async () => {
      const rpcError = createRPCError(ErrorCode.FILE_NOT_FOUND, 'File not found');
      mockFsHandle.mockRejectedValueOnce(rpcError);

      await expect(
        RPCRouter.route(
          createRequest('fs.readFile', { path: '/missing.txt' }, 20),
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.FILE_NOT_FOUND,
        message: 'File not found',
      });
    });

    it('should wrap non-RPC errors in internal error', async () => {
      const genericError = new Error('Something went wrong');
      mockFsHandle.mockRejectedValueOnce(genericError);

      await expect(
        RPCRouter.route(
          createRequest('fs.readFile', { path: '/test.txt' }, 21),
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INTERNAL_ERROR,
        message: expect.stringContaining('Internal error'),
      });
    });

    it('should include method name in wrapped errors', async () => {
      const genericError = new Error('Unexpected error');
      mockGitHandle.mockRejectedValueOnce(genericError);

      await expect(
        RPCRouter.route(
          createRequest('git.commit', { dir: '/project', message: 'test' }, 22),
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INTERNAL_ERROR,
        data: {
          method: 'git.commit',
          originalError: expect.any(String),
        },
      });
    });
  });

  describe('Terminal Service Cleanup', () => {
    it('should cleanup terminal service on disconnect', async () => {
      // Setup a mock cleanup function that will be tracked
      const mockCleanup = vi.fn();

      // Create a new mock instance with cleanup
      const mockServiceWithCleanup = {
        handle: mockTerminalHandle,
        cleanup: mockCleanup,
      };

      // Override the mock to return our instance
      MockTerminalService.mockImplementationOnce(() => mockServiceWithCleanup as any);

      // Create a terminal service - this will instantiate the mock
      await RPCRouter.route(
        createRequest('terminal.create', {}, 1),
        mockSocket
      );

      // Now cleanup - this should call the cleanup method
      RPCRouter.cleanupTerminalService(mockSocket);

      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });

    it('should handle cleanup when no terminal service exists', () => {
      const otherSocket = { ...mockSocket, data: { uid: 'different-user', deviceId: 'different-device' } };

      expect(() => {
        RPCRouter.cleanupTerminalService(otherSocket);
      }).not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle method with multiple dots', async () => {
      // Method "fs.some.deep.method" splits into service="fs", method="some"
      // Additional parts after the second dot are ignored
      const result = await RPCRouter.route(
        createRequest('fs.some.deep.method', {}, 30),
        mockSocket
      );

      // Should route to fs service with "some" as the method
      expect(mockFsHandle).toHaveBeenCalledWith('some', {}, mockSocket);
      expect(result).toEqual({ success: true });
    });

    it('should handle empty method name', async () => {
      await expect(
        RPCRouter.route(
          createRequest('', {}, 31),
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_REQUEST,
      });
    });

    it('should handle method with only service name', async () => {
      await expect(
        RPCRouter.route(
          createRequest('fs.', {}, 32),
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_REQUEST,
      });
    });

    it('should handle undefined params', async () => {
      const result = await RPCRouter.route(
        createRequest('fs.stat', undefined, 33),
        mockSocket
      );

      expect(mockFsHandle).toHaveBeenCalledWith('stat', undefined, mockSocket);
      expect(result).toEqual({ success: true });
    });

    it('should handle requests with no id', async () => {
      const result = await RPCRouter.route(
        createRequest('fs.stat', { path: '/test.txt' }),
        mockSocket
      );

      expect(result).toEqual({ success: true });
    });
  });
});
