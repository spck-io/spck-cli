import { describe, it, expect, beforeEach, vi, type Mock, type Mocked } from 'vitest';
/**
 * Tests for ProxyClient security - Handshake protocol and HMAC verification
 *
 * These tests verify the security fixes for:
 * 1. Handshake bypass prevention (protocol_selected requires authentication)
 * 2. User authentication enforcement when userAuthenticationEnabled is true
 * 3. HMAC verification for all RPC requests
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ErrorCode } from '../../types.js';

// Mock dependencies
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn() },
  generate: vi.fn(),
}));

vi.mock('../../connection/auth.js', () => ({
  verifyFirebaseToken: vi.fn(),
}));

vi.mock('../../config/credentials.js', () => ({
  saveConnectionSettings: vi.fn(),
  loadConnectionSettings: vi.fn(),
  isServerTokenExpired: vi.fn(),
  loadGlobalConfig: vi.fn(() => ({ knownDeviceIds: [] })),
  saveGlobalConfig: vi.fn(),
}));

vi.mock('../../config/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../config/config.js')>(),
  updateConfigFile: vi.fn(),
}));

vi.mock('../../rpc/router.js', () => ({
  RPCRouter: {
    initialize: vi.fn(),
    route: vi.fn(),
    cleanup: vi.fn(),
    setBroadcastCallback: vi.fn(),
  },
}));

vi.mock('../handshake-validation.js', () => ({
  validateHandshakeTimestamp: vi.fn(() => ({ valid: true })),
}));

vi.mock('../../connection/hmac.js', () => ({
  requireValidHMAC: vi.fn(),
  validateHMAC: vi.fn(() => true),
}));

import { ProxyClient } from '../ProxyClient.js';
import { requireValidHMAC } from '../../connection/hmac.js';
import { RPCRouter } from '../../rpc/router.js';
import { validateHandshakeTimestamp } from '../handshake-validation.js';
import { createPinVerifier } from '../../connection/pin.js';
import { io } from 'socket.io-client';
import { loadGlobalConfig, saveGlobalConfig } from '../../config/credentials.js';
import { createDefaultConfig, loadConfig, updateConfigFile } from '../../config/config.js';
import qrcode from 'qrcode-terminal';

const mockRequireValidHMAC = requireValidHMAC as Mock;
const mockRPCRouter = RPCRouter as Mocked<typeof RPCRouter>;
const mockValidateHandshakeTimestamp = validateHandshakeTimestamp as Mock;
const mockLoadGlobalConfig = loadGlobalConfig as Mock;
const mockSaveGlobalConfig = saveGlobalConfig as Mock;

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
function createAuthMessage(secret: string, clientId: string, deviceId: string = 'test-device-123', channelBinding?: string): any {
  const timestamp = Date.now();
  const nonce = Math.random().toString(36).substring(2);
  const signed: any = { type: 'auth', clientId, nonce, deviceId };
  if (channelBinding) signed.channelBinding = channelBinding;
  const message = { ...signed, timestamp };
  const messageToSign = timestamp + JSON.stringify(signed);
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
      hasConnectedEditor: false,
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

  it.each([
    [{ claude: true }, undefined, true],
    [{ codex: true }, undefined, true],
    [{ gemini: true }, undefined, true],
    [{}, undefined, false],
    [{ claude: true, codex: true, gemini: true }, false, false],
  ])('advertises ACP for tools %j with enabled=%s', (tools, enabled, expected) => {
    const client = new ProxyClient({
      ...defaultOptions,
      config: { ...defaultOptions.config, acp: { enabled } },
      tools,
    } as any);
    const send = vi.spyOn(client as any, 'sendToClient').mockImplementation(() => {});
    (client as any).sendProtocolInfo('connection-1');
    expect(send).toHaveBeenCalledWith('connection-1', 'handshake', expect.objectContaining({
      features: expect.objectContaining({ acp: expected }),
    }));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateConfigFile).mockReset();
    defaultOptions.config.hasConnectedEditor = false;
    eventHandlers = {};

    // Create fresh mock socket for each test
    mockSocket = {
      on: vi.fn((event: string, handler: Function) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
      }),
      once: vi.fn((event: string, handler: Function) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
      }),
      off: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
      id: 'mock-socket-id',
    };

    // Update the io mock to return our fresh socket
    (io as Mock).mockReturnValue(mockSocket);

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

  describe('PIN protection', () => {
    const pin = createPinVerifier('123456');
    const options = () => ({ ...defaultOptions, config: { ...defaultOptions.config, security: { userAuthenticationEnabled: false, requirePin: true, pin } } });
    const messages = (id: string) => mockSocket.emit.mock.calls.filter(([event, message]: any[]) => event === 'handshake' && message.connectionId === id).map(([, message]: any[]) => message.data);
    const auth = async (id: string) => {
      await triggerEvent('client_message', { connectionId: id, data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, id) });
      return messages(id).findLast((message: any) => message.type === 'request_pin');
    };

    it('requires PIN before protocol selection or RPC, then accepts a valid proof', async () => {
      const client = await setupClient(options() as any);
      const challenge = await auth('pin-1');
      expect(challenge).toMatchObject({ salt: pin.salt, iterations: pin.iterations });
      expect(messages('pin-1').some((message: any) => message.type === 'protocol_info')).toBe(false);
      await triggerEvent('client_message', { connectionId: 'pin-1', data: { type: 'protocol_selected', version: 1 } });
      expect(messages('pin-1').at(-1)).toMatchObject({ code: 'pin_required' });
      expect(client.getStatus().clients[0].ready).toBe(false);
      const route = vi.spyOn(RPCRouter, 'route');
      await triggerEvent('client_message', { connectionId: 'pin-1', data: createSignedRPCMessage(TEST_SECRET, 'terminal.create', {}) });
      expect(route).not.toHaveBeenCalled();
      const proof = crypto.createHmac('sha256', Buffer.from(pin.hash, 'hex')).update('spck-pin-v1:' + challenge.challenge).digest('hex');
      await triggerEvent('client_message', { connectionId: 'pin-1', data: { type: 'pin_verification', proof } });
      expect(messages('pin-1').at(-1)).toMatchObject({ type: 'protocol_info' });
      await triggerEvent('client_message', { connectionId: 'pin-1', data: { type: 'protocol_selected', version: 1 } });
      expect(client.getStatus().clients[0].ready).toBe(true);
      route.mockRestore();
      client.forceCleanup();
    });

    it('does not reset the retry limit for a new connection or device ID', async () => {
      const client = await setupClient(options() as any);
      for (let i = 0; i < 5; i++) {
        const id = 'wrong-pin-' + i;
        await auth(id);
        await triggerEvent('client_message', { connectionId: id, data: { type: 'pin_verification', proof: '00'.repeat(32) } });
      }
      expect(await auth('another-device')).toMatchObject({ retryAfter: 60 });
      client.forceCleanup();
    });

    it('rejects proofs from a previous challenge and fails closed without a configured PIN', async () => {
      const client = await setupClient(options() as any);
      const old = await auth('old-challenge');
      const proof = crypto.createHmac('sha256', Buffer.from(pin.hash, 'hex')).update('spck-pin-v1:' + old.challenge).digest('hex');
      await auth('old-challenge');
      await triggerEvent('client_message', { connectionId: 'old-challenge', data: { type: 'pin_verification', proof } });
      expect(messages('old-challenge').at(-1)).toMatchObject({ type: 'request_pin', incorrect: true });
      client.forceCleanup();
      await setupClient({ ...options(), config: { ...options().config, security: { requirePin: true } } } as any);
      await auth('unconfigured');
      expect(messages('unconfigured').at(-1)).toMatchObject({ type: 'error', code: 'pin_not_configured' });
    });
  });

  describe('Remembering a connected editor', () => {
    it.each([undefined, 'custom.json'])('persists the first completed handshake with config path %s', async (configPath) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck-pairing-'));
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      try {
        const actualConfig = await vi.importActual<typeof import('../../config/config.js')>('../../config/config.js');
        vi.mocked(updateConfigFile).mockImplementation(actualConfig.updateConfigFile);
        const storedConfig = createDefaultConfig({ root: dir });
        actualConfig.saveConfig(storedConfig, configPath);
        const config = { ...storedConfig, root: '/runtime/override', languageServer: { enabled: false } };
        const client = await setupClient({ ...defaultOptions, config, configPath } as any);

        expect(updateConfigFile).not.toHaveBeenCalled();
        await triggerEvent('client_connecting', { connectionId: 'editor-1' });
        await triggerEvent('client_message', {
          connectionId: 'editor-1', data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID),
        });
        await triggerEvent('client_message', {
          connectionId: 'editor-1', data: { type: 'protocol_selected', version: 2 },
        });
        expect(updateConfigFile).not.toHaveBeenCalled();
        expect(loadConfig(configPath).hasConnectedEditor).toBeUndefined();

        await triggerEvent('client_message', {
          connectionId: 'editor-1', data: { type: 'protocol_selected', version: 1 },
        });
        expect(config.hasConnectedEditor).toBe(true);
        expect(loadConfig(configPath)).toEqual({ ...storedConfig, hasConnectedEditor: true });
        expect(client.getStatus().clients[0].ready).toBe(true);

        await triggerEvent('client_message', {
          connectionId: 'editor-1', data: { type: 'protocol_selected', version: 1 },
        });
        expect(updateConfigFile).toHaveBeenCalledExactlyOnceWith(expect.any(Function), configPath);
        client.forceCleanup();
      } finally {
        cwd.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([undefined, false, true])('shows the startup QR only for an unpaired project (flag: %s)', async (hasConnectedEditor) => {
      await setupClient({ ...defaultOptions, config: { ...defaultOptions.config, hasConnectedEditor } } as any);
      expect(qrcode.generate).toHaveBeenCalledTimes(hasConnectedEditor ? 0 : 1);
    });

    it('keeps a successful connection usable if the preference cannot be saved', async () => {
      vi.mocked(updateConfigFile).mockImplementationOnce(() => { throw new Error('Read-only config'); });
      const client = await setupClient();
      await triggerEvent('client_connecting', { connectionId: 'editor-1' });
      await triggerEvent('client_message', {
        connectionId: 'editor-1', data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID),
      });
      await triggerEvent('client_message', {
        connectionId: 'editor-1', data: { type: 'protocol_selected', version: 1 },
      });
      expect(client.getStatus().clients[0].ready).toBe(true);
      expect(defaultOptions.config.hasConnectedEditor).toBe(true);
      expect(mockSocket.emit).toHaveBeenCalledWith('handshake', expect.objectContaining({
        connectionId: 'editor-1', data: expect.objectContaining({ type: 'connected' }),
      }));
    });
  });

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
      expect(updateConfigFile).not.toHaveBeenCalled();
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
      expect(updateConfigFile).not.toHaveBeenCalled();
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

  describe('Known Device ID Persistence', () => {
    it('should initialize knownDeviceIds from loadGlobalConfig on construction', () => {
      mockLoadGlobalConfig.mockReturnValue({ knownDeviceIds: ['persisted-device-1', 'persisted-device-2'] });

      // Construction triggers loadGlobalConfig via the field initializer
      new ProxyClient(defaultOptions as any);

      expect(mockLoadGlobalConfig).toHaveBeenCalled();
    });

    it('should treat a device from global config as known (no saveGlobalConfig call)', async () => {
      mockLoadGlobalConfig.mockReturnValue({ knownDeviceIds: ['test-device-123'] });

      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'known-conn-1' });

      // Use the pre-loaded device ID — no new-device path should fire
      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'test-device-123');
      await triggerEvent('client_message', { connectionId: 'known-conn-1', data: authMessage });

      expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
    });

    it('should save global config when a genuinely new device connects', async () => {
      mockLoadGlobalConfig.mockReturnValue({ knownDeviceIds: [] });

      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'new-conn-1' });

      const authMessage = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'brand-new-device');
      await triggerEvent('client_message', { connectionId: 'new-conn-1', data: authMessage });

      expect(mockSaveGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ knownDeviceIds: expect.arrayContaining(['brand-new-device']) })
      );
    });

    it('should accumulate multiple new device IDs across connections', async () => {
      mockLoadGlobalConfig.mockReturnValue({ knownDeviceIds: [] });

      await setupClient();

      await triggerEvent('client_connecting', { connectionId: 'conn-a' });
      await triggerEvent('client_message', {
        connectionId: 'conn-a',
        data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'device-alpha'),
      });

      await triggerEvent('client_connecting', { connectionId: 'conn-b' });
      await triggerEvent('client_message', {
        connectionId: 'conn-b',
        data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'device-beta'),
      });

      expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(2);
      // Second call should include both devices
      expect(mockSaveGlobalConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          knownDeviceIds: expect.arrayContaining(['device-alpha', 'device-beta']),
        })
      );
    });

    it('should not save global config again when an already-seen device reconnects', async () => {
      mockLoadGlobalConfig.mockReturnValue({ knownDeviceIds: [] });

      await setupClient();

      // First connection — new device
      await triggerEvent('client_connecting', { connectionId: 'first-conn' });
      await triggerEvent('client_message', {
        connectionId: 'first-conn',
        data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'recurring-device'),
      });

      mockSaveGlobalConfig.mockClear();

      // Second connection — same device
      await triggerEvent('client_connecting', { connectionId: 'second-conn' });
      await triggerEvent('client_message', {
        connectionId: 'second-conn',
        data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'recurring-device'),
      });

      expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
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

  describe('Fast Lane channel binding', () => {
    const BINDING = 'offer=sha-256 AA:BB;answer=sha-256 CC:DD';

    /** Deliver a message as if it arrived over the connection's DataChannel. */
    function fromFastLane(client: ProxyClient, connectionId: string, data: any) {
      (client as any).fastLane.hooks.onMessage(connectionId, 'rpc', data);
      return new Promise(resolve => setImmediate(resolve));
    }

    function authResults(connectionId: string) {
      return mockSocket.emit.mock.calls
        .filter(([event, msg]: any[]) => event === 'handshake' && msg.connectionId === connectionId && msg.data.type === 'auth_result')
        .map(([, msg]: any[]) => msg.data);
    }

    async function setupFastLaneClient(binding: string | null = BINDING) {
      const client = await setupClient();
      vi.spyOn((client as any).fastLane, 'channelBinding').mockReturnValue(binding);
      return client;
    }

    it('accepts a matching binding and returns a proof over it', async () => {
      const client = await setupFastLaneClient();
      const auth = createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'dev-1', BINDING);
      await fromFastLane(client, 'fl-1', auth);

      const [result] = authResults('fl-1');
      expect(result.success).toBe(true);
      const expectedProof = crypto.createHmac('sha256', TEST_SECRET)
        .update(auth.timestamp + JSON.stringify({ type: 'auth_proof', nonce: auth.nonce, channelBinding: BINDING }))
        .digest('hex');
      expect(result.serverProof).toBe(expectedProof);
    });

    it('rejects a binding that differs from the negotiated one (relay swapped fingerprints)', async () => {
      const client = await setupFastLaneClient();
      await fromFastLane(client, 'fl-2', createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'dev-1', 'offer=sha-256 EE;answer=sha-256 CC:DD'));
      expect(authResults('fl-2')).toEqual([expect.objectContaining({ success: false, error: expect.stringMatching(/Channel binding mismatch/) })]);
    });

    it('rejects Fast Lane auth that carries no binding', async () => {
      const client = await setupFastLaneClient();
      await fromFastLane(client, 'fl-3', createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'dev-1'));
      expect(authResults('fl-3')).toEqual([expect.objectContaining({ success: false })]);
    });

    it('rejects Fast Lane auth when no binding can be derived', async () => {
      const client = await setupFastLaneClient(null);
      await fromFastLane(client, 'fl-4', createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'dev-1', BINDING));
      expect(authResults('fl-4')).toEqual([expect.objectContaining({ success: false, error: expect.stringMatching(/unavailable/) })]);
    });

    it('rejects a bound auth that arrives over the relay (forwarded by a middleman)', async () => {
      await setupFastLaneClient();
      await triggerEvent('client_message', {
        connectionId: 'fl-5',
        data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'dev-1', BINDING),
      });
      expect(authResults('fl-5')).toEqual([expect.objectContaining({ success: false })]);
    });

    it('does not sign a binding into the HMAC unless it is the negotiated one', async () => {
      const client = await setupFastLaneClient();
      // Valid HMAC over a stripped message, but a binding field bolted on afterwards.
      const auth = { ...createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'dev-1'), channelBinding: BINDING };
      await fromFastLane(client, 'fl-6', auth);
      expect(authResults('fl-6')).toEqual([expect.objectContaining({ success: false, error: 'Invalid HMAC signature' })]);
    });

    it('ignores relay traffic for a connection authenticated over Fast Lane', async () => {
      const client = await setupFastLaneClient();
      await fromFastLane(client, 'fl-7', createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, 'dev-1', BINDING));
      mockSocket.emit.mockClear();

      await triggerEvent('client_message', { connectionId: 'fl-7', data: { type: 'protocol_selected', version: 1 } });
      expect(mockSocket.emit).not.toHaveBeenCalledWith('handshake', expect.objectContaining({ connectionId: 'fl-7' }));
      expect((client as any).activeConnections.get('fl-7').handshakeComplete).toBeFalsy();

      await fromFastLane(client, 'fl-7', { type: 'protocol_selected', version: 1 });
      expect((client as any).activeConnections.get('fl-7').handshakeComplete).toBe(true);
    });
  });
  describe('Dashboard status and editor latency', () => {
    async function connectEditor(connectionId: string, deviceId: string) {
      await triggerEvent('client_connecting', { connectionId });
      await triggerEvent('client_message', { connectionId, data: createAuthMessage(TEST_SECRET, TEST_CLIENT_ID, deviceId) });
      await triggerEvent('client_message', { connectionId, data: { type: 'protocol_selected', version: 1 } });
    }

    function rpcWithLatency(latency: unknown) {
      return { ...createSignedRPCMessage(TEST_SECRET, 'fs.stat', { path: '/' }), latency };
    }

    beforeEach(() => {
      mockRPCRouter.route.mockResolvedValue({});
    });

    it('shows the round trip the editor reports on its requests', async () => {
      const client = await setupClient();
      const onChange = vi.fn();
      client.onStatusChange(onChange);
      await connectEditor('conn-1', 'device-aaaaaaaa');

      expect(client.getStatus().clients).toEqual([
        expect.objectContaining({ connectionId: 'conn-1', deviceId: 'device-aaaaaaaa', transport: 'relay', ready: true, pingMs: null }),
      ]);

      onChange.mockClear();
      await triggerEvent('client_message', { connectionId: 'conn-1', data: rpcWithLatency(42) });

      expect(client.getStatus().clients[0].pingMs).toBe(42);
      expect(onChange).toHaveBeenCalled();
    });

    it('keeps the last value when an editor sends none or junk', async () => {
      const client = await setupClient();
      await connectEditor('conn-1', 'device-aaaaaaaa');
      await triggerEvent('client_message', { connectionId: 'conn-1', data: rpcWithLatency(30) });

      await triggerEvent('client_message', { connectionId: 'conn-1', data: createSignedRPCMessage(TEST_SECRET, 'fs.stat', {}) });
      await triggerEvent('client_message', { connectionId: 'conn-1', data: rpcWithLatency('fast') });
      await triggerEvent('client_message', { connectionId: 'conn-1', data: rpcWithLatency(-5) });

      expect(client.getStatus().clients[0].pingMs).toBe(30);
    });

    it('ignores latency on requests that fail HMAC verification', async () => {
      const client = await setupClient();
      await connectEditor('conn-1', 'device-aaaaaaaa');
      mockRequireValidHMAC.mockImplementationOnce(() => { throw new Error('bad hmac'); });

      await triggerEvent('client_message', { connectionId: 'conn-1', data: rpcWithLatency(5) });

      expect(client.getStatus().clients[0].pingMs).toBeNull();
    });

    it('forgets disconnected editors', async () => {
      const client = await setupClient();
      await connectEditor('conn-1', 'device-aaaaaaaa');

      await triggerEvent('client_disconnected', { connectionId: 'conn-1' });

      expect(client.getStatus().clients).toEqual([]);
    });

    it('forgets editors when the relay connection drops, since the relay drops them too', async () => {
      const client = await setupClient();
      await connectEditor('conn-1', 'device-aaaaaaaa');

      await triggerEvent('disconnect', 'transport close');

      expect(client.getStatus().clients).toEqual([]);
      client.forceCleanup();
    });

    it('refuses Fast Lane offers once Fast Lane is turned off in the running config', async () => {
      const options = { ...defaultOptions, config: { ...defaultOptions.config, fastLane: { enabled: true } } };
      const client = await setupClient(options as any);
      (client as any).fastLaneSupported = true;
      options.config.fastLane.enabled = false;

      await triggerEvent('client_fast_lane', { connectionId: 'conn-1' });

      expect(mockSocket.emit).toHaveBeenCalledWith('signal', { connectionId: 'conn-1', data: { type: 'abort', reason: 'unsupported' } });
      client.forceCleanup();
    });
  });

  describe('Token refresh during reconnect', () => {
    it('does not exit when the relay drops the socket while a token refresh is in flight', async () => {
      const client = await setupClient();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      // Keep the refresh pending, as it is while refreshFirebaseToken hits the network
      vi.spyOn(client as any, 'refreshTokenAndReconnect').mockReturnValue(new Promise(() => {}));
      try {
        // Relay order: error first, then disconnect(true)
        await triggerEvent('error', { code: 'expired_firebase_token', message: 'Firebase token has expired' });
        await triggerEvent('disconnect', 'io server disconnect');
        expect((client as any).tokenRefreshState).toBe('refreshing');
        expect(exit).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
      }
    });

    it('still exits on a server disconnect when no refresh is running', async () => {
      await setupClient();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      try {
        await triggerEvent('disconnect', 'io server disconnect');
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        exit.mockRestore();
      }
    });
  });

  describe('Duplicate client ID handling', () => {
    const buildAuth = (): Promise<any> => {
      const auth = (io as Mock).mock.lastCall![1].auth;
      return new Promise(resolve => auth(resolve));
    };

    it('asks the relay to prompt on the first connect, as requested', async () => {
      const client = new ProxyClient({ ...defaultOptions, onDuplicate: 'ask' } as any);
      client.connect().catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      const auth = await buildAuth();
      expect(auth.onDuplicate).toBe('ask');
      expect(auth.serverToken).toBe('existing-server-token');
    });

    it('reconnects with the renewed token and yields to another running CLI', async () => {
      await setupClient({ ...defaultOptions, onDuplicate: 'ask' } as any);
      const auth = await buildAuth();
      expect(auth.onDuplicate).toBe('yield');
      expect(auth.serverToken).toBe('mock-server-token');
    });

    it('answers the relay liveness check', async () => {
      await setupClient();
      const ack = vi.fn();
      await triggerEvent('liveness_check', ack);
      expect(ack).toHaveBeenCalledOnce();
    });

    it('rejects connect with client_id_in_use without exiting or complaining', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const client = new ProxyClient({ ...defaultOptions, onDuplicate: 'ask' } as any);
      const connecting = client.connect();
      await new Promise(resolve => setImmediate(resolve));

      await triggerEvent('error', { code: 'client_id_in_use', message: 'in use' });
      await expect(connecting).rejects.toMatchObject({ code: 'client_id_in_use' });

      await triggerEvent('disconnect', 'io server disconnect');
      expect(exit).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      exit.mockRestore();
      consoleError.mockRestore();
    });

    it('explains and exits cleanly when replaced, without retrying', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await setupClient();

      await triggerEvent('error', { code: 'replaced_by_new_connection', message: 'replaced' });

      expect(exit).toHaveBeenCalledWith(0);
      expect(consoleWarn.mock.calls.flat().join(' ')).toContain('Another CLI started using this client ID');
      exit.mockRestore();
      consoleWarn.mockRestore();
    });
  });
});
