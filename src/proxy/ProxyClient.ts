/**
 * Proxy Client - Connects CLI to proxy server
 * Handles authentication, message relay, and handshake protocol
 */

import { io, Socket } from 'socket.io-client';
import * as crypto from 'crypto';
import qrcode from 'qrcode-terminal';
import { verifyFirebaseToken } from '../connection/auth.js';
import { refreshFirebaseToken } from '../connection/firebase-auth.js';
import { loadCredentials } from '../config/credentials.js';
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
import { logAuth, logConnection } from '../utils/logger.js';
import { RPCRouter } from '../rpc/router.js';
import { validateHandshakeTimestamp } from './handshake-validation.js';
import { requireValidHMAC } from '../connection/hmac.js';
import { needsChunking, chunkMessage } from './chunking.js';

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
  proxyServerUrl?: string;
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
  private knownDeviceIds: Set<string> = new Set(); // Track known device IDs
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

    if (!this.options.proxyServerUrl) {
      throw new Error(
        'No relay server configured. Run the CLI again to auto-select a server,\n' +
        'or specify one with: spck --server <server-url>'
      );
    }
    const relayServer = this.options.proxyServerUrl;
    console.log('\n=== Connecting to Relay Server ===\n');
    console.log(`   Relay server: ${relayServer}\n`);

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

      // Clear connection settings since we're reconnecting
      this.connectionSettings = null;
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
        console.error('\n❌ Unhandled error in handleError:', err.message);
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
          `Connection error: ${error.message || error.toString()}\n` +
          `  Namespace: /listen\n` +
          `  Error type: ${error.type || 'unknown'}`
        );
        reject(enhancedError);
      });

      this.socket.once('connect_error', (error: any) => {
        clearTimeout(timeout);
        const currentProxyUrl = `wss://${this.options.proxyServerUrl}`;
        const enhancedError = new Error(
          `Failed to connect to relay server\n` +
          `  URL: ${currentProxyUrl}/listen\n` +
          `  Error: ${error.message || error.toString()}\n` +
          `  \n` +
          `  Possible causes:\n` +
          `  - Server is not reachable (check your internet connection)\n` +
          `  - Network/firewall blocking connection`
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
      console.log('   Reusing existing secret for clientId');
    } else {
      // New clientId or no existing settings - generate new secret
      secret = crypto.randomBytes(SECRET_LENGTH).toString('base64url');
      console.log('   Generated new secret for clientId');
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

    // Build connection URL with optional server name
    let url = `spck://connect?clientId=${clientId}&secret=${secret}`;
    if (this.config.name) {
      url += `&name=${encodeURIComponent(this.config.name)}`;
    }

    console.log('\n' + '='.repeat(60));
    console.log('Scan this QR code with Spck Editor mobile app:');
    console.log('='.repeat(60) + '\n');

    // Generate ASCII QR code
    qrcode.generate(url, { small: true });

    const relayServer = this.options.proxyServerUrl;
    console.log('\n' + '-'.repeat(60));
    console.log(`Client ID: ${clientId}`);
    console.log(`Secret: ${secret}`);
    if (this.config.name) {
      console.log(`Name: ${this.config.name}`);
    }
    console.log(`Relay server: ${relayServer}`);
    console.log('-'.repeat(60));
    console.log(`\nIMPORTANT: The client must select the same relay server`);
    console.log(`(${relayServer}) in Spck Editor to connect.\n`);
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
    console.warn('⚠️  MULTIPLE CONNECTION ATTEMPT DETECTED!');
    console.warn('⚠'.repeat(30));
    console.warn(`\nExisting connections: ${data.existingConnections.length}`);
    console.warn(`New connection ID: ${data.newConnectionId}`);
    console.warn('\nFor security reasons, new connections are rejected by default.');
    console.warn('If you want to allow multiple connections, restart the CLI.\n');
    console.warn('⚠️  If you did not initiate this connection, your client ID');
    console.warn('    may have been compromised. Consider regenerating it.\n');
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
      const displayId = connection?.deviceId || connectionId;
      console.warn(`Unknown message type from ${displayId}:`, data);

    } catch (error: any) {
      const connection = this.activeConnections.get(connectionId);
      const displayId = connection?.deviceId || connectionId;
      console.error(`Error handling message from ${displayId}:`, error.message);

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
        console.warn(`Unknown handshake message type: ${data.type}`);
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
        console.log(`\n🆕 New device connecting: ${deviceId}`);
        console.log(`   This is the first time this device has connected.`);
        console.log(`   If you did not initiate this connection, your credentials may be compromised.\n`);
        this.knownDeviceIds.add(deviceId);
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
        console.log(`   Requesting user verification...`);
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
      console.warn(`Rejecting user_verification from unauthenticated connection: ${displayId}`);
      return;
    }

    const displayId = connection.deviceId;

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
      console.log(`✅ User verified for ${displayId}: ${payload.sub}`);
      connection.userVerified = true;

      // Continue to protocol negotiation
      this.sendProtocolInfo(connectionId);

    } catch (error: any) {
      console.error(`❌ User verification failed for ${displayId}: ${error.message}`);

      // When user verification is required, reject on failure
      if (connection.userVerificationRequired) {
        this.sendToClient(connectionId, 'handshake', {
          type: 'user_verification_result',
          success: false,
          error: error.message,
        });
        return;
      }

      console.log(`   Continuing anyway (verification is optional)`);
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
    if (!connection || !connection.authenticated) {
      const displayId = connection?.deviceId || connectionId;
      console.warn(`Rejecting protocol_selected from unauthenticated connection: ${displayId}`);
      this.sendToClient(connectionId, 'handshake', {
        type: 'error',
        code: 'not_authenticated',
        message: 'Authentication required before protocol selection',
      });
      return;
    }

    const displayId = connection.deviceId;

    // Security check: If user verification is required, ensure it was completed
    if (connection.userVerificationRequired && !connection.userVerified) {
      console.warn(`Rejecting protocol_selected - user verification required but not completed: ${displayId}`);
      this.sendToClient(connectionId, 'handshake', {
        type: 'error',
        code: 'user_verification_required',
        message: 'User verification required before protocol selection',
      });
      return;
    }

    if (version !== 1) {
      console.error(
        `❌ Unsupported protocol version ${version} from ${displayId}. ` +
        `This CLI only supports protocol v1. ` +
        `An upgrade is required: update your client/library (and this CLI, if applicable) to the latest version so protocol versions match. ` +
        `If you installed the CLI globally, run: npm i -g spck@latest`
      );
      return;
    }

    console.log(`✅ Protocol v${version} negotiated with ${displayId}`);

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
    if (!connection || !connection.handshakeComplete) {
      const displayId = connection?.deviceId || connectionId;
      console.warn(`Rejecting RPC from unauthenticated connection: ${displayId}`);
      return;
    }

    const displayId = connection.deviceId;

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
      console.warn(`Invalid RPC message from ${displayId}:`, message);
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

      console.log(`📦 Chunking large ${event} message: ${chunks.length} chunks (~${Math.round(chunks.length * 800 / 1024)}MB) for ${displayId}`);

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

    // Clean up connection tracking
    this.activeConnections.delete(data.connectionId);
  }

  /**
   * Handle proxy error
   */
  private async handleError(error: ProxyErrorEvent): Promise<void> {
    // Special handling for expired_firebase_token - attempt refresh before giving up
    if (error.code === 'expired_firebase_token' && !this.tokenRefreshAttempted) {
      console.warn('\n⚠️  Firebase token expired. Attempting to refresh...');
      this.tokenRefreshAttempted = true;

      try {
        await this.refreshTokenAndReconnect();
        // If successful, the connection will be re-established
        return;
      } catch (refreshError: any) {
        console.error(`\n❌ Token refresh failed: ${refreshError.message}`);
        // Fall through to regular error handling
      }
    }

    // Regular error handling
    console.error(`\n❌ Proxy error: ${error.message}`);

    switch (error.code) {
      case 'subscription_error_4020':
        console.error('\n⚠️  Your access token has expired or timed out.');
        console.error('Please try again or re-authenticate with: spck auth login\n');
        break;

      case 'subscription_error_4021':
        console.error('\n⚠️  Your login token has been revoked.');
        console.error('Please re-authenticate: spck auth logout && spck auth login\n');
        break;

      case 'subscription_error_9996':
        console.error('\n⚠️  Privacy policy consent required.');
        console.error('Please accept the privacy policy in the Spck Editor app');
        console.error('under Account Settings to use this feature.\n');
        break;

      case 'subscription_error_9997':
        console.error('\n⚠️  Your account is being deleted.');
        console.error('Please wait 72 hours before trying again.\n');
        break;

      case 'subscription_error_9998':
        console.error('\n⛔ This account has been banned.');
        console.error('Your account has been banned for violation of the');
        console.error('Terms of Service agreement.\n');
        break;

      case 'subscription_check_failed':
        console.error('\n⚠️  Unable to verify subscription status.');
        console.error('This may be a temporary issue. Please try again later.\n');
        break;

      case 'subscription_required':
        console.error('\n⚠️  This feature requires a paid subscription.');
        console.error('Visit https://spck.io/subscription to upgrade.\n');
        break;

      case 'max_connections_reached': {
        const maxConnections = (error as any).maxConnections || 5;
        console.error(`\n⚠️  Maximum of ${maxConnections} CLI connections reached.`);
        console.error('Close other CLI instances and try again.\n');
        break;
      }

      case 'duplicate_client_id':
        console.error('\n⚠️  A CLI with this client ID is already connected.');
        console.error('This can happen if:');
        console.error('  - Another CLI instance is still running with the same connection');
        console.error('  - A previous connection did not properly disconnect');
        console.error('\nPlease:');
        console.error('  1. Close any other running CLI instances');
        console.error('  2. Wait a few seconds for the previous connection to timeout');
        console.error('  3. Try connecting again\n');
        break;

      case 'expired_firebase_token':
        if (this.tokenRefreshAttempted) {
          console.error('\n⚠️  Firebase token expired and refresh failed.');
          console.error('Please re-authenticate: spck auth login\n');
        } else {
          console.error('\n⚠️  Firebase token expired.');
          console.error('Please re-authenticate: spck auth login\n');
        }
        break;

      case 'invalid_firebase_token':
        console.error('\n⚠️  Firebase token is invalid (not expired).');
        console.error('The token may be corrupted or from a different account.');
        console.error('Please re-authenticate: spck auth login\n');
        break;

      default:
        console.error('\n⚠️  A problem occurred when verifying your subscription.');
        console.error(error.message)
        break;
    }

    process.exit(1);
  }

  /**
   * Handle disconnect from proxy
   */
  private handleDisconnect(reason: string): void {
    console.warn(`\n⚠️  Disconnected from proxy: ${reason}`);

    if (reason === 'io server disconnect') {
      // Server forcefully disconnected us
      console.error('Server terminated connection. Exiting...\n');
      process.exit(1);
    }

    // Socket.IO will auto-reconnect
    console.log('Attempting to reconnect...');
  }

  /**
   * Handle reconnection attempt
   */
  private handleReconnectAttempt(attemptNumber: number): void {
    console.log(`🔄 Reconnection attempt ${attemptNumber}/5...`);
  }

  /**
   * Handle successful reconnection
   */
  private handleReconnect(attemptNumber: number): void {
    console.log(`\n✅ Reconnected after ${attemptNumber} attempts\n`);
  }

  /**
   * Handle reconnection failure
   */
  private handleReconnectFailed(): void {
    console.error('\n❌ Failed to reconnect after 5 attempts.');
    console.error('Exiting...\n');
    process.exit(1);
  }

  /**
   * Graceful disconnect from proxy
   */
  async disconnect(): Promise<void> {
    if (!this.socket) return;

    console.log('\n🛑 Shutting down gracefully...');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('⚠️  Kill acknowledgment timeout, forcing disconnect');
        this.socket?.disconnect();
        resolve();
      }, KILL_TIMEOUT);

      this.socket!.once('killed', () => {
        clearTimeout(timeout);
        console.log('✅ Gracefully disconnected from proxy');
        this.socket?.disconnect();
        resolve();
      });

      this.socket!.emit('kill');
    });
  }
}
