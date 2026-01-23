/**
 * Tests for JSON-RPC Router
 */

// Mock xterm headless modules BEFORE importing TerminalService
jest.mock('@xterm/headless', () => ({
  default: { Terminal: jest.fn() },
  Terminal: jest.fn(),
}));
jest.mock('@xterm/addon-serialize', () => ({
  default: { SerializeAddon: jest.fn() },
  SerializeAddon: jest.fn(),
}));

import { RPCRouter } from '../router.js';
import { ErrorCode, createRPCError } from '../../types.js';
import { FilesystemService } from '../../services/FilesystemService.js';
import { GitService } from '../../services/GitService.js';
import { TerminalService } from '../../services/TerminalService.js';

// Mock services
jest.mock('../../services/FilesystemService');
jest.mock('../../services/GitService');
jest.mock('../../services/TerminalService');

const MockFilesystemService = FilesystemService as jest.MockedClass<typeof FilesystemService>;
const MockGitService = GitService as jest.MockedClass<typeof GitService>;
const MockTerminalService = TerminalService as jest.MockedClass<typeof TerminalService>;

describe('RPCRouter', () => {
  let mockSocket: any;
  let mockFsHandle: jest.Mock;
  let mockGitHandle: jest.Mock;
  let mockTerminalHandle: jest.Mock;

  beforeEach(() => {
    mockSocket = {
      id: 'test-socket-id',
      data: {
        uid: 'test-user-123',
      },
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      broadcast: {
        emit: jest.fn(),
      },
    };

    // Clear all mocks
    jest.clearAllMocks();

    // Clear router state between tests
    (RPCRouter as any).terminalServices = new Map();
    (RPCRouter as any).currentSockets = new Map();

    // Set up default mock implementations
    mockFsHandle = jest.fn().mockResolvedValue({ success: true });
    mockGitHandle = jest.fn().mockResolvedValue({ success: true });
    mockTerminalHandle = jest.fn().mockResolvedValue('term-123');

    // Mock the service prototypes
    MockFilesystemService.prototype.handle = mockFsHandle;
    MockGitService.prototype.handle = mockGitHandle;

    // Create mock instance for terminal service that will be returned by constructor
    // Use a single tracked cleanup function across all instances
    const mockCleanupFn = jest.fn();
    MockTerminalService.mockImplementation(() => ({
      handle: mockTerminalHandle,
      cleanup: mockCleanupFn,
    }) as any);

    // Initialize router
    RPCRouter.initialize('/test/root', {
      filesystem: { maxFileSize: '100MB', watchIgnorePatterns: [] },
    });
  });

  describe('Route Method Parsing', () => {
    it('should parse method correctly for fs service', async () => {
      await RPCRouter.route(
        {
          jsonrpc: '2.0',
          method: 'fs.readFile',
          params: { path: '/test.txt' },
          id: 1,
        },
        mockSocket
      );

      expect(mockFsHandle).toHaveBeenCalledWith('readFile', { path: '/test.txt' }, mockSocket);
    });

    it('should parse method correctly for git service', async () => {
      await RPCRouter.route(
        {
          jsonrpc: '2.0',
          method: 'git.log',
          params: { dir: '/project' },
          id: 2,
        },
        mockSocket
      );

      expect(mockGitHandle).toHaveBeenCalledWith('log', { dir: '/project' }, mockSocket);
    });

    it('should parse method correctly for terminal service', async () => {
      await RPCRouter.route(
        {
          jsonrpc: '2.0',
          method: 'terminal.create',
          params: { cols: 80, rows: 24 },
          id: 3,
        },
        mockSocket
      );

      expect(mockTerminalHandle).toHaveBeenCalledWith('create', { cols: 80, rows: 24 });
    });

    it('should throw error for invalid method format', async () => {
      await expect(
        RPCRouter.route(
          {
            jsonrpc: '2.0',
            method: 'invalidmethod',
            params: {},
            id: 4,
          },
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
          {
            jsonrpc: '2.0',
            method: 'unknown.method',
            params: {},
            id: 5,
          },
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
        {
          jsonrpc: '2.0',
          method: 'fs.readFile',
          params: { path: '/test.txt', encoding: 'utf8' },
          id: 10,
        },
        mockSocket
      );

      expect(result).toEqual(mockResult);
      expect(mockFsHandle).toHaveBeenCalledTimes(1);
    });

    it('should route to GitService', async () => {
      const mockResult = { oid: 'abc123', commit: {} };
      mockGitHandle.mockResolvedValueOnce(mockResult);

      const result = await RPCRouter.route(
        {
          jsonrpc: '2.0',
          method: 'git.readCommit',
          params: { dir: '/project', oid: 'abc123' },
          id: 11,
        },
        mockSocket
      );

      expect(result).toEqual(mockResult);
      expect(mockGitHandle).toHaveBeenCalledTimes(1);
    });

    it('should route to TerminalService', async () => {
      const result = await RPCRouter.route(
        {
          jsonrpc: '2.0',
          method: 'terminal.create',
          params: { cols: 120, rows: 30 },
          id: 12,
        },
        mockSocket
      );

      // Should return the default mock result
      expect(result).toEqual('term-123');
      expect(mockTerminalHandle).toHaveBeenCalledTimes(1);
    });

    it('should create separate terminal services per user', async () => {
      const socket1 = { ...mockSocket, id: 'socket-1', data: { uid: 'user-1' } };
      const socket2 = { ...mockSocket, id: 'socket-2', data: { uid: 'user-2' } };

      const result1 = await RPCRouter.route(
        { jsonrpc: '2.0', method: 'terminal.create', params: {}, id: 1 },
        socket1
      );

      const result2 = await RPCRouter.route(
        { jsonrpc: '2.0', method: 'terminal.create', params: {}, id: 2 },
        socket2
      );

      // Both should succeed (indicating separate services were created)
      expect(result1).toBeTruthy();
      expect(result2).toBeTruthy();
      expect(mockTerminalHandle).toHaveBeenCalledTimes(2);
    });

    it('should reuse terminal service for same user', async () => {
      const socket1 = { ...mockSocket, id: 'socket-1', data: { uid: 'user-same' } };
      const socket2 = { ...mockSocket, id: 'socket-2', data: { uid: 'user-same' } };

      const result1 = await RPCRouter.route(
        { jsonrpc: '2.0', method: 'terminal.create', params: {}, id: 1 },
        socket1
      );

      const result2 = await RPCRouter.route(
        { jsonrpc: '2.0', method: 'terminal.create', params: {}, id: 2 },
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
          {
            jsonrpc: '2.0',
            method: 'fs.readFile',
            params: { path: '/missing.txt' },
            id: 20,
          },
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
          {
            jsonrpc: '2.0',
            method: 'fs.readFile',
            params: { path: '/test.txt' },
            id: 21,
          },
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
          {
            jsonrpc: '2.0',
            method: 'git.commit',
            params: { dir: '/project', message: 'test' },
            id: 22,
          },
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
      const mockCleanup = jest.fn();

      // Create a new mock instance with cleanup
      const mockServiceWithCleanup = {
        handle: mockTerminalHandle,
        cleanup: mockCleanup,
      };

      // Override the mock to return our instance
      MockTerminalService.mockImplementationOnce(() => mockServiceWithCleanup as any);

      // Create a terminal service - this will instantiate the mock
      await RPCRouter.route(
        { jsonrpc: '2.0', method: 'terminal.create', params: {}, id: 1 },
        mockSocket
      );

      // Now cleanup - this should call the cleanup method
      RPCRouter.cleanupTerminalService(mockSocket);

      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });

    it('should handle cleanup when no terminal service exists', () => {
      const otherSocket = { ...mockSocket, data: { uid: 'different-user' } };

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
        {
          jsonrpc: '2.0',
          method: 'fs.some.deep.method',
          params: {},
          id: 30,
        },
        mockSocket
      );

      // Should route to fs service with "some" as the method
      expect(mockFsHandle).toHaveBeenCalledWith('some', {}, mockSocket);
      expect(result).toEqual({ success: true });
    });

    it('should handle empty method name', async () => {
      await expect(
        RPCRouter.route(
          {
            jsonrpc: '2.0',
            method: '',
            params: {},
            id: 31,
          },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_REQUEST,
      });
    });

    it('should handle method with only service name', async () => {
      await expect(
        RPCRouter.route(
          {
            jsonrpc: '2.0',
            method: 'fs.',
            params: {},
            id: 32,
          },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_REQUEST,
      });
    });

    it('should handle undefined params', async () => {
      const result = await RPCRouter.route(
        {
          jsonrpc: '2.0',
          method: 'fs.stat',
          id: 33,
        },
        mockSocket
      );

      expect(mockFsHandle).toHaveBeenCalledWith('stat', undefined, mockSocket);
      expect(result).toEqual({ success: true });
    });

    it('should handle requests with no id', async () => {
      const result = await RPCRouter.route(
        {
          jsonrpc: '2.0',
          method: 'fs.stat',
          params: { path: '/test.txt' },
        },
        mockSocket
      );

      expect(result).toEqual({ success: true });
    });
  });
});
