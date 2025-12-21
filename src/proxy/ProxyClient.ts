/**
 * Proxy Client - Connects CLI to proxy server
 * Handles authentication, message relay, and handshake protocol
 */

import { io, Socket } from 'socket.io-client';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import * as qrcode from 'qrcode-terminal';
import { verifyFirebaseToken } from '../connection/auth.js';
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
  loadConnectionSettings,
  isServerTokenExpired,
} from '../config/credentials.js';
import { RPCRouter } from '../rpc/router.js';
import { validateHandshakeTimestamp } from './handshake-validation.js';

const KILL_TIMEOUT = 3000; // 3 seconds
const SECRET_LENGTH = 40; // 40 characters

interface ProxyClientOptions {
  config: ServerConfig;
  firebaseToken: string;
  userId: string;
  tools: ToolDetectionResult;
  existingConnectionSettings?: ConnectionSettings;
}

/**
 * ProxyClient - Manages connection to proxy server
 */
interface ActiveConnection {
  authenticated: boolean;
  handshakeComplete?: boolean;
  connectedAt: number;
  socketWrapper?: ProxySocketWrapper;
}

export class ProxyClient {
  private socket: Socket | null = null;
  private config: ServerConfig;
  private connectionSettings: ConnectionSettings | null = null;
  private tools: ToolDetectionResult;
  private activeConnections: Map<string, ActiveConnection> = new Map();

  constructor(private options: ProxyClientOptions) {
    this.config = options.config;
    this.tools = options.tools;
  }

  /**
   * Connect to proxy server
   */
  async connect(): Promise<void> {
    const { config, firebaseToken, existingConnectionSettings } = this.options;

    console.log('\n=== Connecting to Proxy Server ===\n');
    console.log(`Proxy URL: ${config.proxyUrl}`);

    // Determine if we're renewing an existing connection
    const existingToken = existingConnectionSettings?.serverToken;

    // Create Socket.IO client
    this.socket = io(config.proxyUrl, {
      path: '/listen',
      transports: ['websocket'],
      auth: {
        firebaseToken,
        serverToken: existingToken,
      },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    // Setup event handlers
    this.setupEventHandlers();

    // Wait for authentication
    await this.waitForAuthentication();
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

    // Error handling
    this.socket.on('error', this.handleError.bind(this));

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
        reject(error);
      });

      this.socket.once('connect_error', (error: any) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Handle authenticated event from proxy
   */
  private handleAuthenticated(data: ProxyAuthenticatedEvent): void {
    console.log('✅ Authenticated with proxy server');

    // Generate shared secret for client authentication
    const secret = crypto.randomBytes(SECRET_LENGTH / 2).toString('hex'); // 40 hex chars

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

    // Display QR code
    this.displayQRCode();
    this.displayConnectionInfo();
  }

  /**
   * Display QR code for client connection
   */
  private displayQRCode(): void {
    if (!this.connectionSettings) return;

    const { clientId, secret } = this.connectionSettings;

    // Build connection URL
    const url = `spck://connect?clientId=${clientId}&secret=${secret}`;

    console.log('\n' + '='.repeat(60));
    console.log('Scan this QR code with Spck Editor mobile app:');
    console.log('='.repeat(60) + '\n');

    // Generate ASCII QR code
    qrcode.generate(url, { small: true });

    console.log('\n' + '-'.repeat(60));
    console.log(`Client ID: ${clientId.substring(0, 16)}...`);
    console.log(`Secret: ${secret}`);
    console.log('-'.repeat(60) + '\n');
  }

  /**
   * Display connection information
   */
  private displayConnectionInfo(): void {
    console.log('='.repeat(60));
    console.log('✅ Server Ready');
    console.log('='.repeat(60) + '\n');

    console.log(`📁 Serving: ${this.config.root}`);
    console.log(`🔒 Client ID: ${this.connectionSettings?.clientId.substring(0, 16)}...`);

    // Display available features
    const features: string[] = ['filesystem'];

    if (this.tools.git) features.push('git');
    if (this.config.terminal.enabled) features.push('terminal');
    if (this.tools.ripgrep) features.push('fast-search');

    console.log(`🔧 Features: ${features.join(', ')}`);

    // Display warnings if any tools are missing
    if (!this.tools.git) {
      console.log(`   ⚠️  git: disabled (not installed)`);
    }
    if (!this.tools.ripgrep) {
      console.log(`   ⚠️  fast-search: disabled (ripgrep not installed)`);
    }

    console.log('\nWaiting for client connections...');
    console.log('Press Ctrl+C to exit\n');
  }

  /**
   * Handle client connecting event
   */
  private handleClientConnecting(data: ProxyClientConnectingEvent): void {
    console.log(`\n🔌 Client connecting: ${data.connectionId}`);
  }

  /**
   * Handle multiple connection attempt
   */
  private handleMultipleConnection(data: ProxyMultipleConnectionEvent): void {
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

      console.warn(`Unknown message type from ${connectionId}:`, data);

    } catch (error: any) {
      console.error(`Error handling message from ${connectionId}:`, error.message);

      // Send error response if it's an RPC message
      if (data.id) {
        this.sendToClient(connectionId, {
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
        await this.handleClientAuth(connectionId, data.jwt);
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
   * Handle client JWT authentication
   */
  private async handleClientAuth(connectionId: string, clientJwt: string): Promise<void> {
    try {
      if (!this.connectionSettings) {
        throw new Error('No connection settings available');
      }

      // Verify client JWT with shared secret
      const payload = jwt.verify(clientJwt, this.connectionSettings.secret) as {
        nonce: string;
        timestamp: number;
        clientId: string;
      };

      // Verify clientId matches
      if (payload.clientId !== this.connectionSettings.clientId) {
        throw new Error('Client ID mismatch');
      }

      // Verify timestamp - replay attack prevention (1 minute tolerance)
      const timestampValidation = validateHandshakeTimestamp(payload.timestamp, {
        maxAge: 60 * 1000, // 1 minute
        clockSkewTolerance: 60 * 1000, // 1 minute
      });

      if (!timestampValidation.valid) {
        throw new Error(timestampValidation.error);
      }

      console.log(`✅ Client authenticated: ${connectionId}`);

      // Create socket wrapper for this connection
      const socketWrapper = new ProxySocketWrapper(
        connectionId,
        this.connectionSettings.userId,
        this.sendToClient.bind(this)
      );

      // Store connection as authenticated
      this.activeConnections.set(connectionId, {
        authenticated: true,
        connectedAt: Date.now(),
        socketWrapper,
      });

      // Send success response
      this.sendToClient(connectionId, {
        type: 'auth_result',
        success: true,
      });

      // Check if user authentication is required
      if (this.config.security.userAuthenticationEnabled) {
        console.log(`   Requesting user verification...`);
        this.sendToClient(connectionId, {
          type: 'request_user_verification',
          message: 'Please provide Firebase authentication',
        });
      } else {
        // Skip to protocol negotiation
        this.sendProtocolInfo(connectionId);
      }

    } catch (error: any) {
      console.error(`❌ Client auth failed for ${connectionId}: ${error.message}`);

      this.sendToClient(connectionId, {
        type: 'auth_result',
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Handle user verification (optional security layer)
   */
  private async handleUserVerification(connectionId: string, firebaseToken: string): Promise<void> {
    try {
      // Verify Firebase token
      const payload = await verifyFirebaseToken(
        firebaseToken,
        'spck-editor',
        [] // No UID restriction for client
      );

      // Check if userId matches
      if (payload.sub !== this.connectionSettings?.userId) {
        console.warn(`⚠️  User ID mismatch for ${connectionId}!`);
        console.warn(`   Expected: ${this.connectionSettings?.userId}`);
        console.warn(`   Received: ${payload.sub}`);
        console.warn(`   This may indicate a security issue.`);
      } else {
        console.log(`✅ User verified for ${connectionId}: ${payload.sub}`);
      }

      // Continue to protocol negotiation regardless
      this.sendProtocolInfo(connectionId);

    } catch (error: any) {
      console.error(`❌ User verification failed for ${connectionId}: ${error.message}`);
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

    this.sendToClient(connectionId, {
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
    if (version !== 1) {
      console.error(`❌ Unsupported protocol version ${version} from ${connectionId}`);
      return;
    }

    console.log(`✅ Protocol v${version} negotiated with ${connectionId}`);

    // Mark connection as fully established
    const connection = this.activeConnections.get(connectionId);
    if (connection) {
      connection.handshakeComplete = true;
    }

    // Send connection established message
    this.sendToClient(connectionId, {
      type: 'connected',
      message: 'Connection established',
    });

    // Notify proxy that handshake is complete
    if (this.socket) {
      this.socket.emit('handshake_complete', { connectionId });
    }

    console.log(`🎉 Client ready: ${connectionId}\n`);
  }

  /**
   * Handle RPC message from client
   */
  private async handleRPCMessage(connectionId: string, message: any): Promise<void> {
    // Check if connection is authenticated and handshake complete
    const connection = this.activeConnections.get(connectionId);
    if (!connection || !connection.handshakeComplete) {
      console.warn(`Rejecting RPC from unauthenticated connection: ${connectionId}`);
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
      console.warn(`Invalid RPC message from ${connectionId}:`, message);
      return;
    }

    // Handle RPC request
    try {
      // Route to appropriate service with socket wrapper
      const result = await RPCRouter.route(message as JSONRPCRequest, connection.socketWrapper as any);

      // Send response
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        result,
        id: message.id || null,
      };

      this.sendToClient(connectionId, response);

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

      this.sendToClient(connectionId, response);
    }
  }

  /**
   * Send message to client via proxy
   */
  private sendToClient(connectionId: string, data: any): void {
    if (!this.socket) return;

    this.socket.emit('cli_message', {
      connectionId,
      data,
    });
  }

  /**
   * Handle client disconnected event
   */
  private handleClientDisconnected(data: ProxyClientDisconnectedEvent): void {
    console.log(`\n🔌 Client disconnected: ${data.connectionId}`);

    // Clean up connection tracking
    this.activeConnections.delete(data.connectionId);
  }

  /**
   * Handle proxy error
   */
  private handleError(error: ProxyErrorEvent): void {
    console.error(`\n❌ Proxy error [${error.code}]: ${error.message}`);

    if (error.code === 'subscription_required') {
      console.error('\nThis feature requires a paid subscription.');
      console.error('Visit https://spck.io/subscription to upgrade.\n');
      process.exit(1);
    }

    if (error.code === 'max_connections_reached') {
      console.error('\nMaximum of 5 CLI connections per account.');
      console.error('Close other CLI instances and try again.\n');
      process.exit(1);
    }

    if (error.code === 'invalid_firebase_token') {
      console.error('\nFirebase authentication failed.');
      console.error('Please re-authenticate and try again.\n');
      process.exit(1);
    }
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
