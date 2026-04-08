/**
 * Proxy Client - Connects CLI to proxy server
 * Handles authentication, message relay, and handshake protocol
 */

import { io, Socket } from 'socket.io-client';
import * as crypto from 'crypto';
import qrcode from 'qrcode-terminal';
import { verifyFirebaseToken } from '../connection/auth.js';
import { refreshFirebaseToken } from '../connection/firebase-auth.js';
import { loadCredentials, loadGlobalConfig, saveGlobalConfig } from '../config/credentials.js';
import { ProxySocketWrapper } from './ProxySocketWrapper.js';
import {
  ServerConfig,
  ConnectionSettings,
  ToolDetectionResult,
  ProxyAuthenticatedEvent,
  ProxyClientConnectingEvent,
  ProxyMultipleConnectionEvent,
  ProxyClientMessageEvent,
  ProxyClientDisconnectedEvent,
  ProxyErrorEvent,
  JSONRPCRequest,
  JSONRPCResponse,
  ErrorCode,
  createRPCError,
} from '../types.js';
import {
  saveConnectionSettings,
} from '../config/credentials.js';
import { t } from '../i18n/index.js';
import { logAuth, logConnection } from '../utils/logger.js';
import { RPCRouter } from '../rpc/router.js';
import { validateHandshakeTimestamp } from './handshake-validation.js';
import { requireValidHMAC } from '../connection/hmac.js';
import { needsChunking, chunkMessage } from './chunking.js';

function formatTimeUntilReset(resetTime?: number): string {
  const now = Date.now();
  const target = resetTime ?? Date.UTC(
    new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1
  );
  const msLeft = Math.max(0, target - now);
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const KILL_TIMEOUT = 5000; // 5 seconds
const SECRET_LENGTH = 33;
// No default URL - proxyServerUrl must always be provided via options
// (auto-selected by ping or overridden via --server flag)

interface ProxyClientOptions {
  config: ServerConfig;
  firebaseToken: string;
  userId: string;
  tools: ToolDetectionResult;
  existingConnectionSettings?: ConnectionSettings;
  proxyServerUrl: string;
}

/**
 * ProxyClient - Manages connection to proxy server
 */
interface ActiveConnection {
  authenticated: boolean;
  userVerified?: boolean;
  userVerificationRequired?: boolean;
  handshakeComplete?: boolean;
  connectedAt: number;
  socketWrapper?: ProxySocketWrapper;
  deviceId?: string;
}

export class ProxyClient {
  private socket: Socket | null = null;
  private config: ServerConfig;
  private connectionSettings: ConnectionSettings | null = null;
  private tools: ToolDetectionResult;
  private activeConnections: Map<string, ActiveConnection> = new Map();
  private knownDeviceIds: Set<string> = new Set(loadGlobalConfig().knownDeviceIds); // Track known device IDs
  private firebaseToken: string;
  private userId: string;
  private tokenRefreshAttempted: boolean = false;

  constructor(private options: ProxyClientOptions) {
    this.config = options.config;
    this.tools = options.tools;
    this.firebaseToken = options.firebaseToken;
    this.userId = options.userId;
  }

  /**
   * Connect to proxy server
   */
  async connect(): Promise<void> {
    const { existingConnectionSettings } = this.options;

    const relayServer = this.options.proxyServerUrl;
    console.log(`\n=== ${t('connection.title')} ===\n`);
    console.log(`   ${t('connection.relayServer', { server: relayServer })}\n`);

    // Determine if we're renewing an existing connection
    const existingToken = existingConnectionSettings?.serverToken;

    // Create Socket.IO client - connect to /listen namespace
    // Note: /listen is a Socket.IO namespace, not an HTTP path
    const namespaceUrl = `wss://${relayServer}/listen`;
    this.socket = io(namespaceUrl, {
      transports: ['websocket'],
      auth: {
        firebaseToken: this.firebaseToken,
        serverToken: existingToken,
      },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 25000,
    } as any);

    // Setup event handlers
    this.setupEventHandlers();

    // Wait for authentication
    await this.waitForAuthentication();
  }

  /**
   * Refresh firebase token and reconnect
   */
  private async refreshTokenAndReconnect(): Promise<void> {
    try {
      logAuth('token_refresh_start', { userId: this.userId });

      // Load stored credentials to get refresh token
      const storedCredentials = loadCredentials();
      if (!storedCredentials) {
        throw new Error('No stored credentials available for token refresh');
      }

      // Refresh the Firebase token
      const newCredentials = await refreshFirebaseToken(storedCredentials);

      // Update internal state
      this.firebaseToken = newCredentials.firebaseToken;
      this.userId = newCredentials.userId;

      logAuth('token_refresh_success', { userId: this.userId });

      // Disconnect current socket
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      // Preserve connection settings for secret reuse, clear active connections
      this.activeConnections.clear();

      // Reconnect with new token
      logAuth('reconnect_with_new_token', { userId: this.userId });
      await this.connect();

    } catch (error: any) {
      throw new Error(`Failed to refresh token: ${error.message}`);
    }
  }

  /**
   * Setup all event handlers
   */
  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Authentication successful
    this.socket.on('authenticated', this.handleAuthenticated.bind(this));

    // Client events
    this.socket.on('client_connecting', this.handleClientConnecting.bind(this));
    this.socket.on('multiple_connection_attempt', this.handleMultipleConnection.bind(this));
    this.socket.on('client_message', this.handleClientMessage.bind(this));
    this.socket.on('client_disconnected', this.handleClientDisconnected.bind(this));

    // Error handling (async wrapper for handleError)
    this.socket.on('error', (error: ProxyErrorEvent) => {
      this.handleError(error).catch((err) => {
        console.error(`\n❌ ${t('connection.unhandledError')}`, err.message);
        process.exit(1);
      });
    });

    // Connection state
    this.socket.on('disconnect', this.handleDisconnect.bind(this));
    this.socket.on('reconnect_attempt', this.handleReconnectAttempt.bind(this));
    this.socket.on('reconnect', this.handleReconnect.bind(this));
    this.socket.on('reconnect_failed', this.handleReconnectFailed.bind(this));
  }

  /**
   * Wait for authentication to complete
   */
  private waitForAuthentication(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket not initialized'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 30000); // 30 second timeout

      this.socket.once('authenticated', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.socket.once('error', (error: any) => {
        clearTimeout(timeout);
        const enhancedError = new Error(
          `${t('connection.connectError', { message: error.message || error.toString() })}\n` +
          `  ${t('connection.connectErrorNamespace')}\n` +
          `  ${t('connection.connectErrorType', { type: error.type || 'unknown' })}`
        );
        reject(enhancedError);
      });

      this.socket.once('connect_error', (error: any) => {
        clearTimeout(timeout);
        const currentProxyUrl = `wss://${this.options.proxyServerUrl}`;
        const enhancedError = new Error(
          `${t('connection.connectFailed')}\n` +
          `  ${t('connection.connectFailedUrl', { url: currentProxyUrl })}\n` +
          `  ${t('connection.connectFailedError', { message: error.message || error.toString() })}\n` +
          `  \n` +
          `  ${t('connection.connectFailedCauses')}\n` +
          `  ${t('connection.connectFailedCause1')}\n` +
          `  ${t('connection.connectFailedCause2')}`
        );
        reject(enhancedError);
      });
    });
  }

  /**
   * Handle authenticated event from proxy
   */
  private handleAuthenticated(data: ProxyAuthenticatedEvent): void {
    logAuth('proxy_authenticated', { userId: data.userId, clientId: data.clientId });

    // Track if this is a new CLI session (vs automatic reconnection in same session)
    const isNewSession = this.connectionSettings === null;

    // Reuse existing secret if clientId matches, otherwise generate new one
    // Check current connectionSettings first (for reconnections), then initial options
    const existingSettings = this.connectionSettings || this.options.existingConnectionSettings;
    let secret: string;

    if (existingSettings && existingSettings.clientId === data.clientId) {
      // Same clientId - reuse the secret
      secret = existingSettings.secret;
      console.log(`   ${t('connection.reusingSecret')}`);
    } else {
      // New clientId or no existing settings - generate new secret
      secret = crypto.randomBytes(SECRET_LENGTH).toString('base64url');
      console.log(`   ${t('connection.generatedSecret')}`);
    }

    // Save connection settings
    this.connectionSettings = {
      serverToken: data.token,
      serverTokenExpiry: data.expiresAt,
      clientId: data.clientId,
      secret,
      userId: data.userId,
      connectedAt: Date.now(),
    };

    saveConnectionSettings(this.connectionSettings);

    // Show free tier notice on new sessions
    if (isNewSession && data.freeTierInfo) {
      const { dailyLimitSeconds, usedSeconds } = data.freeTierInfo;
      const limitMinutes = Math.floor(dailyLimitSeconds / 60);
      const usedMinutes = Math.floor(usedSeconds / 60);
      const remainingMinutes = Math.max(0, limitMinutes - usedMinutes);
      console.log(`\nℹ️  ${t('connection.freeTierNotice', { used: usedMinutes, limit: limitMinutes, remaining: remainingMinutes })}`);
      console.log(`   ${t('connection.freeTierUpgrade')}\n`);
    }

    // Display QR code on new CLI session or if clientId changed (not on automatic reconnections)
    if (isNewSession || this.connectionSettings.clientId !== existingSettings?.clientId) {
      this.displayQRCode();
    }
  }

  /**
   * Display QR code for client connection
   */
  private displayQRCode(): void {
    if (!this.connectionSettings) return;

    const { clientId, secret } = this.connectionSettings;

    // Build connection URL with relay server and optional server name
    const relayServer = this.options.proxyServerUrl;
    let url = `spck://connect?clientId=${clientId}&secret=${secret}&rs=${encodeURIComponent(relayServer)}`;
    if (this.config.name) {
      url += `&name=${encodeURIComponent(this.config.name)}`;
    }

    console.log('\n' + '='.repeat(60));
    console.log(t('connection.scanQR'));
    console.log('='.repeat(60) + '\n');

    // Generate ASCII QR code
    qrcode.generate(url, { small: true });

    console.log('\n' + '-'.repeat(60));
    console.log(t('connection.clientId', { id: clientId }));
    console.log(t('connection.secret', { secret }));
    if (this.config.name) {
      console.log(t('connection.name', { name: this.config.name }));
    }
    console.log(t('connection.relayServerLabel', { server: relayServer }));
    console.log('-'.repeat(60));
    console.log(`\n${t('connection.relayServerMismatch')}`);
    console.log(`${t('connection.relayServerMismatchHint', { server: relayServer })}\n`);
  }

  /**
   * Handle client connecting event
   */
  private handleClientConnecting(data: ProxyClientConnectingEvent): void {
    // Connection not yet authenticated, so we don't have deviceId yet
    logConnection('connecting', undefined, { connectionId: data.connectionId });
  }

  /**
   * Handle multiple connection attempt
   */
  private handleMultipleConnection(data: ProxyMultipleConnectionEvent): void {
    logAuth('multiple_connection_attempt', {
      existingConnections: data.existingConnections.length,
      newConnectionId: data.newConnectionId,
      userId: this.userId
    }, 'warn');

    console.warn('\n' + '⚠'.repeat(30));
    console.warn(`⚠️  ${t('multipleConnection.detected')}`);
    console.warn('⚠'.repeat(30));
    console.warn(`\n${t('multipleConnection.existingCount', { count: data.existingConnections.length })}`);
    console.warn(t('multipleConnection.newConnectionId', { id: data.newConnectionId }));
    console.warn(`\n${t('multipleConnection.rejectedHint')}`);
    console.warn(`${t('multipleConnection.restartHint')}\n`);
    console.warn(`⚠️  ${t('multipleConnection.compromiseWarning')}`);
    console.warn(`    ${t('multipleConnection.compromiseHint')}\n`);
  }

  /**
   * Handle client message (includes handshake and RPC)
   */
  private async handleClientMessage(msg: ProxyClientMessageEvent): Promise<void> {
    const { connectionId, data } = msg;

    try {
      // Handle handshake protocol messages
      if (data.type) {
        await this.handleHandshakeMessage(connectionId, data);
        return;
      }

      // Handle RPC messages (after handshake complete)
      if (data.jsonrpc === '2.0') {
        await this.handleRPCMessage(connectionId, data);
        return;
      }

      const connection = this.activeConnections.get(connectionId);
      const displayId = connection?.deviceId ?? '';
      console.warn(`${t('connection.unknownMessageType', { deviceId: displayId })}:`, data);

    } catch (error: any) {
      const connection = this.activeConnections.get(connectionId);
      const displayId = connection?.deviceId ?? '';
      console.error(`${t('connection.errorHandlingMessage', { deviceId: displayId })}:`, error.message);

      // Send error response if it's an RPC message
      if (data.id) {
        this.sendToClient(connectionId, 'rpc', {
          jsonrpc: '2.0',
          error: createRPCError(ErrorCode.INTERNAL_ERROR, error.message),
          id: data.id,
        });
      }
    }
  }

  /**
   * Handle handshake protocol messages
   */
  private async handleHandshakeMessage(connectionId: string, data: any): Promise<void> {
    switch (data.type) {
      case 'auth':
        await this.handleClientAuth(connectionId, data);
        break;

      case 'user_verification':
        await this.handleUserVerification(connectionId, data.firebaseToken);
        break;

      case 'protocol_selected':
        await this.handleProtocolSelection(connectionId, data.version);
        break;

      default:
        console.warn(t('connection.unknownHandshakeType', { type: data.type }));
    }
  }

  /**
   * Handle client HMAC authentication
   */
  private async handleClientAuth(connectionId: string, authMessage: any): Promise<void> {
    try {
      if (!this.connectionSettings) {
        throw new Error('No connection settings available');
      }

      const { clientId, timestamp, nonce, hmac, deviceId } = authMessage;

      // Verify deviceId is provided (required)
      if (!deviceId) {
        throw new Error('Device ID is required for authentication');
      }

      // Verify clientId matches
      if (clientId !== this.connectionSettings.clientId) {
        throw new Error('Client ID mismatch');
      }

      // Verify timestamp - replay attack prevention (1 minute tolerance)
      const timestampValidation = validateHandshakeTimestamp(timestamp, {
        maxAge: 60 * 1000, // 1 minute
        clockSkewTolerance: 60 * 1000, // 1 minute
      });

      if (!timestampValidation.valid) {
        throw new Error(timestampValidation.error);
      }

      // Verify HMAC signature (always includes deviceId)
      const messageToVerify = { type: 'auth', clientId, timestamp, nonce, deviceId };
      const expectedHmac = this.computeHMAC(messageToVerify, this.connectionSettings.secret);
      if (hmac !== expectedHmac) {
        throw new Error('Invalid HMAC signature');
      }

      // Check if this is a new device
      const isNewDevice = !this.knownDeviceIds.has(deviceId);
      if (isNewDevice) {
        logAuth('new_device_connecting', {
          deviceId,
          userId: this.connectionSettings.userId,
          firstConnection: true
        }, 'warn');
        console.log(`\n🆕 ${t('connection.newDevice', { deviceId })}`);
        console.log(`   ${t('connection.newDeviceWarning')}`);
        console.log(`   ${t('connection.newDeviceCompromised')}\n`);
        this.knownDeviceIds.add(deviceId);
        saveGlobalConfig({ knownDeviceIds: Array.from(this.knownDeviceIds) });
      }

      logConnection('authenticated', deviceId, {
        connectionId,
        userId: this.connectionSettings.userId
      });

      // Create socket wrapper for this connection
      const socketWrapper = new ProxySocketWrapper(
        connectionId,
        this.connectionSettings.userId,
        this.sendToClient.bind(this),
        deviceId
      );

      // Store connection as authenticated
      const userVerificationRequired = this.config.security.userAuthenticationEnabled;
      this.activeConnections.set(connectionId, {
        authenticated: true,
        userVerified: false,
        userVerificationRequired,
        connectedAt: Date.now(),
        socketWrapper,
        deviceId,
      });

      // Send success response
      this.sendToClient(connectionId, 'handshake', {
        type: 'auth_result',
        success: true,
      });

      // Check if user authentication is required
      if (userVerificationRequired) {
        console.log(`   ${t('connection.userVerifying')}`);
        this.sendToClient(connectionId, 'handshake', {
          type: 'request_user_verification',
          message: 'Please provide Firebase authentication',
        });
      } else {
        // Skip to protocol negotiation
        this.sendProtocolInfo(connectionId);
      }

    } catch (error: any) {
      const { deviceId } = authMessage;
      logConnection('auth_failed', deviceId, {
        connectionId,
        error: error.message,
        userId: this.connectionSettings?.userId
      });

      this.sendToClient(connectionId, 'handshake', {
        type: 'auth_result',
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Handle user verification (required when userAuthenticationEnabled)
   */
  private async handleUserVerification(connectionId: string, firebaseToken: string): Promise<void> {
    const connection = this.activeConnections.get(connectionId);
    if (!connection || !connection.authenticated) {
      const displayId = connection?.deviceId || connectionId;
      console.warn(t('connection.rejectingUnauthenticated', { event: 'user_verification', deviceId: displayId }));
      return;
    }

    const displayId = connection.deviceId || connectionId;

    try {
      // Verify Firebase token
      // If userAuthenticationEnabled, restrict to the userId from connection settings
      const allowedUids = this.config.security.userAuthenticationEnabled && this.connectionSettings?.userId
        ? [this.connectionSettings.userId]
        : [];

      const payload = await verifyFirebaseToken(
        firebaseToken,
        'spck-editor',
        allowedUids
      );

      // If we get here, token is valid and UID matches (if userAuthenticationEnabled)
      console.log(`✅ ${t('connection.userVerified', { deviceId: displayId, userId: payload.sub ?? '' })}`);
      connection.userVerified = true;

      // Continue to protocol negotiation
      this.sendProtocolInfo(connectionId);

    } catch (error: any) {
      console.error(`❌ ${t('connection.userVerifyFailed', { deviceId: displayId, message: error.message })}`);

      // When user verification is required, reject on failure
      if (connection.userVerificationRequired) {
        this.sendToClient(connectionId, 'handshake', {
          type: 'user_verification_result',
          success: false,
          error: error.message,
        });
        return;
      }

      console.log(`   ${t('connection.userVerifyOptional')}`);
      // Continue to protocol negotiation
      this.sendProtocolInfo(connectionId);
    }
  }

  /**
   * Send protocol information to client
   */
  private sendProtocolInfo(connectionId: string): void {
    const features = {
      terminal: this.config.terminal.enabled,
      git: this.tools.git,
      fastSearch: this.tools.ripgrep,
      browserProxy: this.config.browserProxy?.enabled ?? true,
    };

    this.sendToClient(connectionId, 'handshake', {
      type: 'protocol_info',
      minVersion: 1,
      maxVersion: 1,
      features,
    });
  }

  /**
   * Handle protocol version selection
   */
  private async handleProtocolSelection(connectionId: string, version: number): Promise<void> {
    // Security check: Verify connection is properly authenticated before completing handshake
    const connection = this.activeConnections.get(connectionId);
    const displayId = connection?.deviceId ?? '';
    if (!connection || !connection.authenticated) {
      console.warn(t('connection.rejectingUnauthenticated', { event: 'protocol_selected', deviceId: displayId }));
      this.sendToClient(connectionId, 'handshake', {
        type: 'error',
        code: 'not_authenticated',
        message: 'Authentication required before protocol selection',
      });
      return;
    }

    // Security check: If user verification is required, ensure it was completed
    if (connection.userVerificationRequired && !connection.userVerified) {
      console.warn(t('connection.rejectingUserVerification', { deviceId: displayId }));
      this.sendToClient(connectionId, 'handshake', {
        type: 'error',
        code: 'user_verification_required',
        message: 'User verification required before protocol selection',
      });
      return;
    }

    if (version !== 1) {
      console.error(
        `❌ ${t('connection.protocolUnsupported', { version, deviceId: displayId })}`
      );
      return;
    }

    console.log(`✅ ${t('connection.protocolNegotiated', { version, deviceId: displayId })}`);

    // Mark connection as fully established
    connection.handshakeComplete = true;

    // Send connection established message
    this.sendToClient(connectionId, 'handshake', {
      type: 'connected',
      message: 'Connection established',
    });

    // Notify proxy that handshake is complete
    if (this.socket) {
      this.socket.emit('handshake_complete', { connectionId });
    }

    logConnection('ready', connection.deviceId, {
      connectionId,
      protocolVersion: version
    });
  }

  /**
   * Handle RPC message from client
   */
  private async handleRPCMessage(connectionId: string, message: any): Promise<void> {
    // Check if connection is authenticated and handshake complete
    const connection = this.activeConnections.get(connectionId);
    const displayId = connection?.deviceId ?? '';
    if (!connection || !connection.handshakeComplete) {
      console.warn(t('connection.rejectingUnauthenticated', { event: 'RPC', deviceId: displayId }));
      return;
    }

    // Distinguish between RPC request (has method) and RPC response (has result/error)
    const isRequest = 'method' in message;
    const isResponse = 'result' in message || 'error' in message;

    if (isResponse) {
      // This is a response from the client (e.g., auth response)
      // Trigger 'rpc' event listeners on the socket wrapper
      if (connection.socketWrapper) {
        connection.socketWrapper.triggerEvent('rpc', message);
      }
      return;
    }

    if (!isRequest) {
      console.warn(`${t('connection.invalidRpcMessage', { deviceId: displayId })}:`, message);
      return;
    }

    // Handle RPC request
    try {
      // Verify HMAC signature - REQUIRED for all RPC requests
      if (!this.connectionSettings?.secret) {
        throw createRPCError(
          ErrorCode.INTERNAL_ERROR,
          'Server configuration error: signing key not available'
        );
      }
      requireValidHMAC(message as JSONRPCRequest, this.connectionSettings.secret);

      // Route to appropriate service with socket wrapper
      const result = await RPCRouter.route(message as JSONRPCRequest, connection.socketWrapper as any);

      // Send response
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        result,
        id: message.id || null,
      };

      this.sendToClient(connectionId, 'rpc', response);

    } catch (error: any) {
      // Send error response
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        error: error.code && error.message ? error : createRPCError(
          ErrorCode.INTERNAL_ERROR,
          error.message || 'Internal error'
        ),
        id: message.id || null,
      };

      this.sendToClient(connectionId, 'rpc', response);
    }
  }

  /**
   * Send message to client via proxy
   * Automatically chunks large payloads (>800kB)
   */
  private sendToClient(connectionId: string, event: string, data: any): void {
    if (!this.socket) return;

    // Check if message needs chunking
    if (needsChunking(data)) {
      // Chunk the message
      const chunks = chunkMessage(event, data);
      const connection = this.activeConnections.get(connectionId);
      const displayId = connection?.deviceId || connectionId;

      console.log(`📦 ${t('connection.chunkingMessage', { event, chunks: chunks.length, size: Math.round(chunks.length * 800 / 1024), deviceId: displayId })}`);

      // Send each chunk as an 'rpc' event with special __chunk marker
      // This ensures chunks are routed correctly through the proxy-server
      for (const chunk of chunks) {
        this.socket.emit('rpc', {
          connectionId,
          data: {
            __chunk: true,
            ...chunk,
          },
        });
      }
    } else {
      // Send normally for small messages
      this.socket.emit(event, {
        connectionId,
        data,
      });
    }
  }

  /**
   * Compute HMAC for message verification
   */
  private computeHMAC(message: object, secret: string): string {
    const { timestamp, ...rest } = message as any;
    const messageToSign = timestamp + JSON.stringify(rest);
    return crypto.createHmac('sha256', secret).update(messageToSign).digest('hex');
  }

  /**
   * Handle client disconnected event
   */
  private handleClientDisconnected(data: ProxyClientDisconnectedEvent): void {
    const connection = this.activeConnections.get(data.connectionId);
    logConnection('disconnected', connection?.deviceId, {
      connectionId: data.connectionId
    });

    if (data.reason === 'daily_limit_exceeded') {
      console.warn(`\n⚠️  ${t('proxyError.dailyLimitExceeded')}`);
      console.warn(`${t('proxyError.dailyLimitReset', { time: formatTimeUntilReset(data.resetTime) })}`);
      console.warn(`${t('proxyError.dailyLimitExceededHint')}\n`);
    }

    // Clean up connection tracking
    this.activeConnections.delete(data.connectionId);
  }

  /**
   * Handle proxy error
   */
  private async handleError(error: ProxyErrorEvent): Promise<void> {
    // Special handling for expired_firebase_token - attempt refresh before giving up
    if (error.code === 'expired_firebase_token' && !this.tokenRefreshAttempted) {
      console.warn(`\n⚠️  ${t('proxyError.firebaseTokenExpiring')}`);
      this.tokenRefreshAttempted = true;

      try {
        await this.refreshTokenAndReconnect();
        // If successful, the connection will be re-established
        return;
      } catch (refreshError: any) {
        console.error(`\n❌ ${t('proxyError.tokenRefreshFailed', { message: refreshError.message })}`);
        // Fall through to regular error handling
      }
    }

    // Regular error handling
    console.error(`\n❌ ${t('proxyError.error', { message: error.message })}`);

    switch (error.code) {
      case 'subscription_error_4020':
        console.error(`\n⚠️  ${t('proxyError.tokenExpiredTimeout')}`);
        console.error(`${t('proxyError.tokenExpiredHint')}\n`);
        break;

      case 'subscription_error_4021':
        console.error(`\n⚠️  ${t('proxyError.tokenRevoked')}`);
        console.error(`${t('proxyError.tokenRevokedHint')}\n`);
        break;

      case 'subscription_error_9996':
        console.error(`\n⚠️  ${t('proxyError.privacyConsent')}`);
        console.error(t('proxyError.privacyConsentHint1'));
        console.error(`${t('proxyError.privacyConsentHint2')}\n`);
        break;

      case 'subscription_error_9997':
        console.error(`\n⚠️  ${t('proxyError.accountDeleting')}`);
        console.error(`${t('proxyError.accountDeletingHint')}\n`);
        break;

      case 'subscription_error_9998':
        console.error(`\n⛔ ${t('proxyError.accountBanned')}`);
        console.error(t('proxyError.accountBannedHint1'));
        console.error(`${t('proxyError.accountBannedHint2')}\n`);
        break;

      case 'subscription_check_failed':
        console.error(`\n⚠️  ${t('proxyError.subscriptionCheckFailed')}`);
        console.error(`${t('proxyError.subscriptionCheckFailedHint')}\n`);
        break;

      case 'subscription_required':
        console.error(`\n⚠️  ${t('proxyError.subscriptionRequired')}`);
        console.error(`${t('proxyError.subscriptionRequiredHint')}\n`);
        break;

      case 'daily_limit_exceeded':
        console.error(`\n⚠️  ${t('proxyError.dailyLimitExceeded')}`);
        console.error(`${t('proxyError.dailyLimitReset', { time: formatTimeUntilReset(error.resetTime) })}`);
        console.error(`${t('proxyError.dailyLimitExceededHint')}\n`);
        break;

      case 'max_connections_reached': {
        const maxConnections = (error as any).maxConnections || 5;
        console.error(`\n⚠️  ${t('proxyError.maxConnections', { max: maxConnections })}`);
        console.error(`${t('proxyError.maxConnectionsHint')}\n`);
        break;
      }

      case 'duplicate_client_id':
        console.error(`\n⚠️  ${t('proxyError.duplicateClientId')}`);
        console.error(t('proxyError.duplicateHint1'));
        console.error(`  ${t('proxyError.duplicateHint2')}`);
        console.error(`  ${t('proxyError.duplicateHint3')}`);
        console.error(`\n${t('proxyError.duplicateHint4')}`);
        console.error(`  ${t('proxyError.duplicateHint5')}`);
        console.error(`  ${t('proxyError.duplicateHint6')}`);
        console.error(`  ${t('proxyError.duplicateHint7')}\n`);
        break;

      case 'expired_firebase_token':
        if (this.tokenRefreshAttempted) {
          console.error(`\n⚠️  ${t('proxyError.firebaseExpiredRefreshFailed')}`);
          console.error(`${t('proxyError.firebaseExpiredRefreshFailedHint')}\n`);
        } else {
          console.error(`\n⚠️  ${t('proxyError.firebaseExpired')}`);
          console.error(`${t('proxyError.firebaseExpiredHint')}\n`);
        }
        break;

      case 'invalid_firebase_token':
        console.error(`\n⚠️  ${t('proxyError.firebaseInvalid')}`);
        console.error(t('proxyError.firebaseInvalidHint1'));
        console.error(`${t('proxyError.firebaseInvalidHint2')}\n`);
        break;

      default:
        console.error(`\n⚠️  ${t('proxyError.defaultError')}`);
        console.error(error.message)
        break;
    }

    process.exit(1);
  }

  /**
   * Handle disconnect from proxy
   */
  private handleDisconnect(reason: string): void {
    console.warn(`\n⚠️  ${t('connection.disconnectedFromProxy', { reason })}`);

    if (reason === 'io server disconnect') {
      // Server forcefully disconnected us
      console.error(`${t('connection.serverTerminated')}\n`);
      process.exit(1);
    }

    // Socket.IO will auto-reconnect
    console.log(t('connection.attemptingReconnect'));
  }

  /**
   * Handle reconnection attempt
   */
  private handleReconnectAttempt(attemptNumber: number): void {
    console.log(`🔄 ${t('connection.reconnectAttempt', { attempt: attemptNumber })}`);
  }

  /**
   * Handle successful reconnection
   */
  private handleReconnect(attemptNumber: number): void {
    console.log(`\n✅ ${t('connection.reconnected', { attempts: attemptNumber })}\n`);
  }

  /**
   * Handle reconnection failure
   */
  private handleReconnectFailed(): void {
    console.error(`\n❌ ${t('connection.reconnectFailed')}`);
    console.error(`${t('connection.exiting')}\n`);
    process.exit(1);
  }

  /**
   * Graceful disconnect from proxy
   */
  async disconnect(): Promise<void> {
    if (!this.socket) return;

    console.log(`\n🛑 ${t('connection.shuttingDown')}`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`⚠️  ${t('connection.killTimeout')}`);
        this.socket?.disconnect();
        resolve();
      }, KILL_TIMEOUT);

      this.socket!.once('killed', () => {
        clearTimeout(timeout);
        console.log(`✅ ${t('connection.gracefulDisconnect')}`);
        this.socket?.disconnect();
        resolve();
      });

      this.socket!.emit('kill');
    });
  }
}
