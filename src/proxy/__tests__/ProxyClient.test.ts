/**
 * Tests for ProxyClient security - Handshake protocol and HMAC verification
 *
 * These tests verify the security fixes for:
 * 1. Handshake bypass prevention (protocol_selected requires authentication)
 * 2. User authentication enforcement when userAuthenticationEnabled is true
 * 3. HMAC verification for all RPC requests
 */

import * as crypto from 'crypto';
import { ErrorCode } from '../../types.js';

// Mock dependencies
jest.mock('socket.io-client', () => ({
  io: jest.fn(() => mockSocket),
}));

jest.mock('qrcode-terminal', () => ({
  generate: jest.fn(),
}));

jest.mock('../../connection/auth.js', () => ({
  verifyFirebaseToken: jest.fn(),
}));

jest.mock('../../config/credentials.js', () => ({
  saveConnectionSettings: jest.fn(),
  loadConnectionSettings: jest.fn(),
  isServerTokenExpired: jest.fn(),
}));

jest.mock('../../rpc/router.js', () => ({
  RPCRouter: {
    initialize: jest.fn(),
    route: jest.fn(),
    cleanup: jest.fn(),
  },
}));

jest.mock('../handshake-validation.js', () => ({
  validateHandshakeTimestamp: jest.fn(() => ({ valid: true })),
}));

jest.mock('../../connection/hmac.js', () => ({
  requireValidHMAC: jest.fn(),
  validateHMAC: jest.fn(() => true),
}));

import { ProxyClient } from '../ProxyClient.js';
import { requireValidHMAC } from '../../connection/hmac.js';
import { RPCRouter } from '../../rpc/router.js';
import { validateHandshakeTimestamp } from '../handshake-validation.js';

const mockRequireValidHMAC = requireValidHMAC as jest.Mock;
const mockRPCRouter = RPCRouter as jest.Mocked<typeof RPCRouter>;
const mockValidateHandshakeTimestamp = validateHandshakeTimestamp as jest.Mock;

// Shared mock socket that all tests use
let mockSocket: any;
let eventHandlers: Record<string, Function[]>;

const TEST_SECRET = 'test-secret-key-12345678901234567890';
const TEST_CLIENT_ID = 'test-client-id';

/**
 * Helper to trigger all handlers for an event
 */
async function triggerEvent(event: string, data: any): Promise<void> {
  const handlers = eventHandlers[event] || [];
  for (const handler of handlers) {
    await handler(data);
  }
}

/**
 * Create HMAC-signed auth message
 */
function createAuthMessage(secret: string, clientId: string, deviceId: string = 'test-device-123'): any {
  const timestamp = Date.now();
  const nonce = Math.random().toString(36).substring(2);
  const message = { type: 'auth', clientId, timestamp, nonce, deviceId };
  const messageToSign = timestamp + JSON.stringify({ type: 'auth', clientId, nonce, deviceId });
  const hmac = crypto.createHmac('sha256', secret).update(messageToSign).digest('hex');
  return { ...message, hmac };
}

/**
 * Create signed RPC message with HMAC
 */
function createSignedRPCMessage(secret: string, method: string, params: any, id: number = 1): any {
  const timestamp = Date.now();
  const payload = { jsonrpc: '2.0', method, params, id };
  const messageToSign = timestamp + JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret).update(messageToSign).digest('hex');
  return { ...payload, timestamp, hmac };
}

describe('ProxyClient Security', () => {
  const defaultOptions = {
    config: {
      security: { userAuthenticationEnabled: false },
      terminal: { enabled: true },
      filesystem: { maxFileSize: '100MB', watchIgnorePatterns: [] },
      rootPath: '/test/root',
    },
    firebaseToken: 'mock-firebase-token',
    userId: 'test-user-123',
    tools: {
      node: { available: true, version: '18.0.0', path: '/usr/bin/node' },
      git: { available: true, version: '2.39.0', path: '/usr/bin/git' },
    },
    existingConnectionSettings: {
      serverToken: 'existing-server-token',
      serverTokenExpiry: Date.now() + 86400000,
      clientId: TEST_CLIENT_ID,
      secret: TEST_SECRET,
      userId: 'test-user-123',
      connectedAt: Date.now(),
    },
    proxyServerUrl: 'cli-na-1.spck.io',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    eventHandlers = {};

    // Create fresh mock socket for each test
    mockSocket = {
      on: jest.fn((event: string, handler: Function) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
      }),
      once: jest.fn((event: string, handler: Function) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
      }),
      off: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      id: 'mock-socket-id',
    };

    // Update the io mock to return our fresh socket
    const { io } = require('socket.io-client');
    io.mockReturnValue(mockSocket);

    mockValidateHandshakeTimestamp.mockReturnValue({ valid: true });
    mockRequireValidHMAC.mockImplementation(() => {});
  });

  /**
   * Setup an authenticated client and return it
   */
  async function setupClient(options = defaultOptions): Promise<ProxyClient> {
    const client = new ProxyClient(options as any);

    // Start connection (non-blocking)
    client.connect().catch(() => {}); // Ignore connection errors in tests

    // Wait for handlers to be set up
    await new Promise(resolve => setImmediate(resolve));

    // Trigger authenticated event
    await triggerEvent('authenticated', {
      clientId: TEST_CLIENT_ID,
      token: 'mock-server-token',
      expiresAt: Date.now() + 86400000,
      userId: 'test-user-123',
    });

    await new Promise(resolve => setImmediate(resolve));
    return client;
  }

  describe('Handshake Bypass Prevention', () => {
    it('should reject protocol_selected from unauthenticated connection', async () => {
      await setupClient();

      // Client connects but doesn't authenticate
      await triggerEvent('client_connecting', { connectionId: 'attacker-1' });

      // Try to skip auth and send protocol_selected directly
      await triggerEvent('client_message', {
        connectionId: 'attacker-1',
        data: { type: 'protocol_selected', version: 1 },
      });

      // Should receive error
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'handshake',
        expect.objectContaining({
          connectionId: 'attacker-1',
          data: expect.objectContaining({
            type: 'error',
            code: 'not_authenticated',
          }),
        })
      );
    });

    it('should reject RPC from connection without completed handshake', async () => {
      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'partial-1' });

      // Authenticate but don't complete protocol selection
      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID);

      await triggerEvent('client_message', {
        connectionId: 'partial-1',
        data: authMessage,
      });

      // Try to send RPC before completing handshake
      const rpcMessage = createSignedRPCMessage(TEST_SECRET, 'terminal.list', {});
      await triggerEvent('client_message', {
        connectionId: 'partial-1',
        data: rpcMessage,
      });

      // RPCRouter should NOT be called
      expect(mockRPCRouter.route).not.toHaveBeenCalled();
    });

    it('should accept RPC after completed handshake', async () => {
      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'valid-1' });

      // Complete full handshake
      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID);

      await triggerEvent('client_message', {
        connectionId: 'valid-1',
        data: authMessage,
      });

      await triggerEvent('client_message', {
        connectionId: 'valid-1',
        data: { type: 'protocol_selected', version: 1 },
      });

      // Now send RPC
      mockRPCRouter.route.mockResolvedValue([]);
      const rpcMessage = createSignedRPCMessage(TEST_SECRET, 'terminal.list', {});

      await triggerEvent('client_message', {
        connectionId: 'valid-1',
        data: rpcMessage,
      });

      // RPCRouter should be called
      expect(mockRPCRouter.route).toHaveBeenCalled();
    });
  });

  describe('User Authentication Enforcement', () => {
    it('should require user verification when enabled', async () => {
      const optionsWithUserAuth = {
        ...defaultOptions,
        config: {
          ...defaultOptions.config,
          security: { userAuthenticationEnabled: true },
        },
      };

      await setupClient(optionsWithUserAuth);

      await triggerEvent('client_connecting', { connectionId: 'user-auth-1' });

      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID);

      await triggerEvent('client_message', {
        connectionId: 'user-auth-1',
        data: authMessage,
      });

      // Should request user verification
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'handshake',
        expect.objectContaining({
          connectionId: 'user-auth-1',
          data: expect.objectContaining({
            type: 'request_user_verification',
          }),
        })
      );
    });

    it('should reject protocol_selected when user verification required but not done', async () => {
      const optionsWithUserAuth = {
        ...defaultOptions,
        config: {
          ...defaultOptions.config,
          security: { userAuthenticationEnabled: true },
        },
      };

      await setupClient(optionsWithUserAuth);

      await triggerEvent('client_connecting', { connectionId: 'skip-verify-1' });

      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID);

      await triggerEvent('client_message', {
        connectionId: 'skip-verify-1',
        data: authMessage,
      });

      // Try to skip user verification
      await triggerEvent('client_message', {
        connectionId: 'skip-verify-1',
        data: { type: 'protocol_selected', version: 1 },
      });

      // Should receive error
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'handshake',
        expect.objectContaining({
          connectionId: 'skip-verify-1',
          data: expect.objectContaining({
            type: 'error',
            code: 'user_verification_required',
          }),
        })
      );
    });
  });

  describe('HMAC Verification', () => {
    it('should verify HMAC on all RPC requests', async () => {
      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'hmac-1' });

      // Complete handshake
      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID);

      await triggerEvent('client_message', {
        connectionId: 'hmac-1',
        data: authMessage,
      });

      await triggerEvent('client_message', {
        connectionId: 'hmac-1',
        data: { type: 'protocol_selected', version: 1 },
      });

      // Send RPC
      mockRPCRouter.route.mockResolvedValue({ result: 'ok' });
      const rpcMessage = createSignedRPCMessage(TEST_SECRET, 'fs.readFile', { path: '/test.txt' });

      await triggerEvent('client_message', {
        connectionId: 'hmac-1',
        data: rpcMessage,
      });

      // HMAC should be verified
      expect(mockRequireValidHMAC).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'fs.readFile' }),
        TEST_SECRET
      );
    });

    it('should reject RPC with invalid HMAC', async () => {
      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'bad-hmac-1' });

      // Complete handshake
      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID);

      await triggerEvent('client_message', {
        connectionId: 'bad-hmac-1',
        data: authMessage,
      });

      await triggerEvent('client_message', {
        connectionId: 'bad-hmac-1',
        data: { type: 'protocol_selected', version: 1 },
      });

      // Mock HMAC to fail
      mockRequireValidHMAC.mockImplementation(() => {
        throw { code: ErrorCode.HMAC_VALIDATION_FAILED, message: 'HMAC validation failed' };
      });

      // Send RPC with bad HMAC
      await triggerEvent('client_message', {
        connectionId: 'bad-hmac-1',
        data: {
          jsonrpc: '2.0',
          method: 'fs.readFile',
          params: { path: '/test.txt' },
          id: 1,
          timestamp: Date.now(),
          hmac: 'invalid-signature',
        },
      });

      // Should return HMAC error
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          connectionId: 'bad-hmac-1',
          data: expect.objectContaining({
            jsonrpc: '2.0',
            error: expect.objectContaining({
              code: ErrorCode.HMAC_VALIDATION_FAILED,
            }),
            id: 1,
          }),
        })
      );

      // RPCRouter should NOT be called
      expect(mockRPCRouter.route).not.toHaveBeenCalled();
    });
  });

  describe('Auth HMAC Validation', () => {
    it('should reject auth with invalid HMAC signature', async () => {
      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'bad-hmac-auth-1' });

      // Create auth message with wrong secret
      const badAuthMessage = createAuthMessage('wrong-secret', TEST_CLIENT_ID);

      await triggerEvent('client_message', {
        connectionId: 'bad-hmac-auth-1',
        data: badAuthMessage,
      });

      // Should reject
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'handshake',
        expect.objectContaining({
          connectionId: 'bad-hmac-auth-1',
          data: expect.objectContaining({
            type: 'auth_result',
            success: false,
          }),
        })
      );
    });

    it('should reject auth with expired timestamp', async () => {
      mockValidateHandshakeTimestamp.mockReturnValue({
        valid: false,
        error: 'Timestamp too old',
      });

      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'old-ts-1' });

      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID);

      await triggerEvent('client_message', {
        connectionId: 'old-ts-1',
        data: authMessage,
      });

      // Should reject
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'handshake',
        expect.objectContaining({
          connectionId: 'old-ts-1',
          data: expect.objectContaining({
            type: 'auth_result',
            success: false,
          }),
        })
      );
    });
  });
});
