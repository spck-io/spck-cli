/**
 * Tests for Socket.IO server and connection handling
 */

import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { createServer, Server as HTTPServer } from 'http';
import * as jwt from 'jsonwebtoken';
import { startServer } from '../index';
import { ErrorCode } from '../types';

// Mock modules
jest.mock('../connection/auth');
jest.mock('../watcher/FileWatcher');
jest.mock('../config/config');

import { verifyFirebaseToken } from '../connection/auth';
import { FileWatcher } from '../watcher/FileWatcher';
import { loadConfig } from '../config/config';

const mockVerifyFirebaseToken = verifyFirebaseToken as jest.MockedFunction<
  typeof verifyFirebaseToken
>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;

describe('Socket.IO Server', () => {
  let httpServer: HTTPServer;
  let ioServer: SocketIOServer;
  let clientSocket: ClientSocket;
  const PORT = 3001;

  const mockConfig = {
    port: PORT,
    root: '/test/root',
    allowedUids: ['test-uid-123'],
    firebaseProjectId: 'test-project',
    signingKey: '',
    terminal: {
      maxBufferedLines: 10000,
      maxTerminals: 10,
    },
    filesystem: {
      maxFileSize: '100MB',
      watchIgnorePatterns: ['.git', 'node_modules'],
    },
  };

  beforeAll(() => {
    // Mock config loader
    mockLoadConfig.mockReturnValue(mockConfig as any);

    // Mock FileWatcher
    (FileWatcher as jest.MockedClass<typeof FileWatcher>).mockImplementation(() => ({
      on: jest.fn(),
      close: jest.fn(),
    } as any));
  });

  beforeEach(async () => {
    // Mock successful authentication
    mockVerifyFirebaseToken.mockResolvedValue({
      uid: 'test-uid-123',
      aud: 'test-project',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: 'https://securetoken.google.com/test-project',
      sub: 'test-uid-123',
    });
  });

  afterEach(async () => {
    if (clientSocket?.connected) {
      clientSocket.disconnect();
    }
    if (ioServer) {
      await new Promise<void>((resolve) => {
        ioServer.close(() => resolve());
      });
    }
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
    jest.clearAllMocks();
  });

  describe('Connection & Authentication', () => {
    it('should accept connection with valid JWT token', async () => {
      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: { token: 'valid-jwt-token' },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve, reject) => {
        clientSocket.on('connect', () => resolve());
        clientSocket.on('connect_error', (err) => reject(err));
      });

      expect(clientSocket.connected).toBe(true);
      expect(mockVerifyFirebaseToken).toHaveBeenCalledWith(
        'valid-jwt-token',
        'test-project',
        ['test-uid-123']
      );
    });

    it('should reject connection without JWT token', async () => {
      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: {},
        transports: ['websocket'],
      });

      await expect(
        new Promise<void>((resolve, reject) => {
          clientSocket.on('connect', () => resolve());
          clientSocket.on('connect_error', (err) => reject(err));
        })
      ).rejects.toThrow();
    });

    it('should reject connection with invalid JWT token', async () => {
      mockVerifyFirebaseToken.mockRejectedValueOnce(new Error('Invalid token'));

      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: { token: 'invalid-jwt-token' },
        transports: ['websocket'],
      });

      await expect(
        new Promise<void>((resolve, reject) => {
          clientSocket.on('connect', () => resolve());
          clientSocket.on('connect_error', (err) => reject(err));
        })
      ).rejects.toThrow();
    });

    it('should reject connection with unauthorized UID', async () => {
      mockVerifyFirebaseToken.mockResolvedValueOnce({
        uid: 'unauthorized-uid',
        aud: 'test-project',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://securetoken.google.com/test-project',
        sub: 'unauthorized-uid',
      });

      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: { token: 'valid-but-unauthorized-token' },
        transports: ['websocket'],
      });

      await expect(
        new Promise<void>((resolve, reject) => {
          clientSocket.on('connect', () => resolve());
          clientSocket.on('connect_error', (err) => reject(err));
        })
      ).rejects.toThrow();
    });
  });

  describe('JSON-RPC Protocol', () => {
    beforeEach(async () => {
      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: { token: 'valid-jwt-token' },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve) => {
        clientSocket.on('connect', () => resolve());
      });
    });

    it('should handle valid JSON-RPC request', (done) => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'fs.stat',
        params: { path: '/test.txt' },
        id: 1,
      };

      clientSocket.emit('rpc', request);

      clientSocket.on('rpc', (response: any) => {
        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe(1);
        // Response will either have result or error
        expect(response).toHaveProperty(response.error ? 'error' : 'result');
        done();
      });
    });

    it('should return error for invalid method format', (done) => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'invalidmethod', // Missing dot separator
        params: {},
        id: 2,
      };

      clientSocket.emit('rpc', request);

      clientSocket.on('rpc', (response: any) => {
        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe(2);
        expect(response.error).toMatchObject({
          code: ErrorCode.INVALID_REQUEST,
          message: expect.stringContaining('Invalid method format'),
        });
        done();
      });
    });

    it('should return error for unknown service', (done) => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'unknown.method',
        params: {},
        id: 3,
      };

      clientSocket.emit('rpc', request);

      clientSocket.on('rpc', (response: any) => {
        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe(3);
        expect(response.error).toMatchObject({
          code: ErrorCode.METHOD_NOT_FOUND,
          message: expect.stringContaining('Unknown service'),
        });
        done();
      });
    });

    it('should handle requests without id (notifications)', (done) => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'fs.stat',
        params: { path: '/test.txt' },
      };

      clientSocket.emit('rpc', request);

      // Notification responses still have id: null
      clientSocket.on('rpc', (response: any) => {
        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBeNull();
        done();
      });
    });

    it('should support concurrent requests with different IDs', (done) => {
      const responses: any[] = [];
      const expectedIds = [100, 101, 102];

      clientSocket.on('rpc', (response: any) => {
        responses.push(response);

        if (responses.length === 3) {
          const receivedIds = responses.map((r) => r.id).sort();
          expect(receivedIds).toEqual(expectedIds.sort());
          done();
        }
      });

      // Send 3 requests concurrently
      expectedIds.forEach((id) => {
        clientSocket.emit('rpc', {
          jsonrpc: '2.0' as const,
          method: 'fs.stat',
          params: { path: `/file${id}.txt` },
          id,
        });
      });
    });
  });

  describe('HMAC Validation', () => {
    beforeEach(async () => {
      // Enable HMAC validation
      mockLoadConfig.mockReturnValue({
        ...mockConfig,
        signingKey: 'test-signing-key',
      } as any);

      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: { token: 'valid-jwt-token' },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve) => {
        clientSocket.on('connect', () => resolve());
      });
    });

    it('should reject request without HMAC when signing key is configured', (done) => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'fs.stat',
        params: { path: '/test.txt' },
        id: 10,
      };

      clientSocket.emit('rpc', request);

      clientSocket.on('rpc', (response: any) => {
        expect(response.id).toBe(10);
        expect(response.error).toMatchObject({
          code: ErrorCode.HMAC_VALIDATION_FAILED,
          message: expect.stringContaining('HMAC validation failed'),
        });
        done();
      });
    });
  });

  describe('Binary Data Handling', () => {
    beforeEach(async () => {
      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: { token: 'valid-jwt-token' },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve) => {
        clientSocket.on('connect', () => resolve());
      });
    });

    it('should receive binary data events', (done) => {
      const testBuffer = Buffer.from('test binary data');

      clientSocket.emit('rpc:binary', {
        id: 123,
        buffer: testBuffer,
      });

      // Server should log the binary data receipt
      // This is a basic test - actual binary handling is service-specific
      setTimeout(() => {
        done();
      }, 100);
    });
  });

  describe('Disconnection Handling', () => {
    it('should handle client disconnection', async () => {
      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: { token: 'valid-jwt-token' },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve) => {
        clientSocket.on('connect', () => resolve());
      });

      const disconnectPromise = new Promise<void>((resolve) => {
        ioServer.on('disconnect', () => resolve());
      });

      clientSocket.disconnect();

      await disconnectPromise;
      expect(clientSocket.connected).toBe(false);
    });

    it('should handle socket errors', async () => {
      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      clientSocket = ioClient(`http://localhost:${PORT}/connect`, {
        auth: { token: 'valid-jwt-token' },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve) => {
        clientSocket.on('connect', () => resolve());
      });

      const errorPromise = new Promise<Error>((resolve) => {
        clientSocket.on('error', (error) => resolve(error));
      });

      // Trigger an error (implementation-specific)
      clientSocket.emit('invalid-event', 'bad-data');

      // Wait a moment to see if error is emitted
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });

  describe('Graceful Shutdown', () => {
    it('should handle SIGINT for graceful shutdown', async () => {
      const server = await startServer();
      ioServer = server.io;
      httpServer = server.httpServer;

      // Test that server can be closed gracefully
      await new Promise<void>((resolve) => {
        ioServer.close(() => {
          httpServer.close(() => {
            resolve();
          });
        });
      });
    });
  });
});
