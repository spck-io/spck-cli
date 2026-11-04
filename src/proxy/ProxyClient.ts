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
import { FastLaneManager, FastLaneSignal, FRAMING_VERSION } from './transport/FastLane.js';

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
const SECRET_LENGTH = 44; // ~262 bits of entropy
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Alphanumeric only, so the secret survives double-click selection and copy/paste.
// crypto.randomInt is uniform, so no modulo bias.
function generateSecret(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHANUMERIC[crypto.randomInt(ALPHANUMERIC.length)];
  return out;
}
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
  // Transport the auth handshake completed on; the connection is pinned to it.
  transport?: 'relay' | 'fastlane';
  // Round trip the editor last reported on an RPC request (optional field)
  pingMs?: number;
}

export type FastLaneState = 'checking' | 'available' | 'unsupported' | 'disabled';

export interface ClientStatus {
  connectionId: string;
  deviceId?: string;
  transport: 'relay' | 'fastlane';
  connectedAt: number;
  ready: boolean;
  /** Round trip last reported by the editor, or null if it hasn't sent one */
  pingMs: number | null;
}

export interface ProxyStatus {
  relayUrl: string;
  relayConnected: boolean;
  clientId?: string;
  fastLane: FastLaneState;
  clients: ClientStatus[];
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
  private tokenRefreshState: 'idle' | 'refreshing' | 'failed' = 'idle';
  // Set when the server emits a 'rate_limited' error. Suppresses the
  // process.exit() that handleDisconnect would otherwise do on
  // 'io server disconnect', so the outer connect loop can wait + retry.
  private suppressServerDisconnectExit = false;

  // Custom reconnect backoff schedule (ms between attempts). Past the last
  // entry we keep retrying at that interval until MAX_RECONNECT_ATTEMPTS.
  // Socket.IO's built-in `reconnectionDelay * 2^attempt` curve can't produce
  // this exact sequence, so we disable it (`reconnection: false`) and drive
  // reconnects from handleDisconnect / handleSocketConnectError.
  private static readonly RECONNECT_SCHEDULE_MS = [1000, 5000, 10000, 20000, 30000, 60000];
  private static readonly MAX_RECONNECT_ATTEMPTS = 35;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  // True once initial auth completes. Pre-auth failures are owned by
  // waitForAuthentication; our scheduler should only kick in afterwards.
  private initialConnectAuthed = false;

  // Fast Lane (direct WebRTC). The relay socket stays up as the control and
  // signaling channel; per connection, replies go out on whichever transport
  // the editor last spoke on, so a mid-negotiation fallback to the relay
  // can never strand responses on a half-open DataChannel.
  private fastLane: FastLaneManager;
  private fastLaneSupported = false;
  private fastLaneState: FastLaneState = 'checking';
  private connectionTransport: Map<string, 'relay' | 'fastlane'> = new Map();

  private statusListeners: Set<() => void> = new Set();

  constructor(private options: ProxyClientOptions) {
    this.config = options.config;
    this.tools = options.tools;
    this.firebaseToken = options.firebaseToken;
    this.userId = options.userId;

    this.fastLane = new FastLaneManager({
      sendSignal: (connectionId: string, signal: FastLaneSignal) => {
        this.socket?.emit('signal', { connectionId, data: signal });
      },
      onOpen: (connectionId: string) => {
        logConnection('fast_lane_open', this.activeConnections.get(connectionId)?.deviceId, { connectionId });
        this.notifyStatus();
      },
      onMessage: (connectionId: string, event: string, data: any) => {
        if (event !== 'rpc') return;
        if (this.isPinnedElsewhere(connectionId, 'fastlane')) return;
        this.connectionTransport.set(connectionId, 'fastlane');
        this.handleClientMessage({ connectionId, data }, 'fastlane').catch(() => {});
      },
      onClose: (connectionId: string, reason: string, wasOpen: boolean) => {
        if (this.connectionTransport.get(connectionId) === 'fastlane') {
          // Editor will tear down its relay socket and reconnect; until then
          // nothing more can reach it, so forget the connection's transport.
          this.connectionTransport.delete(connectionId);
        }
        if (wasOpen) {
          logConnection('fast_lane_closed', this.activeConnections.get(connectionId)?.deviceId, { connectionId, reason });
        }
        this.notifyStatus();
      },
    });

    RPCRouter.setBroadcastCallback((method: string, params: any) => {
      for (const [connectionId, connection] of this.activeConnections) {
        if (connection.handshakeComplete) {
          this.sendToClient(connectionId, 'rpc', { jsonrpc: '2.0', method, params });
        }
      }
    });
  }

  /**
   * Connect to proxy server
   */
  async connect(): Promise<void> {
    const { existingConnectionSettings } = this.options;

    const relayServer = this.options.proxyServerUrl;
    console.log(`\n=== ${t('connection.title')} ===\n`);

    // Determine if we're renewing an existing connection
    const existingToken = existingConnectionSettings?.serverToken;

    // Advertise Fast Lane only when the native WebRTC binding loaded and the
    // project hasn't opted out. Older relays ignore the extra auth field.
    // `auth` is a callback so the socket + handlers are created synchronously
    // while the (async, cached) WebRTC probe runs on each (re)connect.
    const fastLaneEnabled = this.config.fastLane?.enabled ?? true;
    let fastLaneAnnounced = false;
    const buildAuth = (cb: (data: object) => void) => {
      const probe = fastLaneEnabled ? FastLaneManager.isSupported() : Promise.resolve(false);
      probe.then((supported) => {
        this.fastLaneSupported = supported;
        this.fastLaneState = supported ? 'available' : fastLaneEnabled ? 'unsupported' : 'disabled';
        this.notifyStatus();
        if (!fastLaneAnnounced) {
          fastLaneAnnounced = true;
          console.log(`   ${t(supported
            ? 'connection.fastLaneAvailable'
            : fastLaneEnabled ? 'connection.fastLaneUnavailable' : 'connection.fastLaneDisabled')}\n`);
        }
        cb({
          firebaseToken: this.firebaseToken,
          serverToken: existingToken,
          // When Fast Lane is off, say why so the relay can tell the editor
          // something actionable. A CLI that sends no capabilities at all
          // predates Fast Lane and is reported as outdated.
          capabilities: supported
            ? { fastLane: FRAMING_VERSION }
            : { fastLane: 0, fastLaneUnavailable: fastLaneEnabled ? 'unsupported' : 'disabled' },
        });
      });
    };

    // Create Socket.IO client - connect to /listen namespace
    // Note: /listen is a Socket.IO namespace, not an HTTP path
    const namespaceUrl = `wss://${relayServer}/listen`;
    this.socket = io(namespaceUrl, {
      transports: ['websocket'],
      auth: buildAuth,
      reconnection: false, // custom schedule — see RECONNECT_SCHEDULE_MS
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

      // Disconnect current socket and tear down reconnect state — a timer
      // scheduled against the old socket would fire after we've assigned a
      // new one, and the stale `initialConnectAuthed=true` would let the
      // persistent connect_error handler keep scheduling against the new
      // pre-auth socket. Reset everything so connect() starts clean.
      this.resetReconnectState();
      this.resetEditorSessions();
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }

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
    this.socket.on('client_message', (msg: ProxyClientMessageEvent) => {
      if (this.isPinnedElsewhere(msg.connectionId, 'relay')) return;
      // The editor speaking over the relay means it isn't (or is no longer)
      // using Fast Lane for this connection — drop any half-built peer.
      if (this.fastLane.has(msg.connectionId)) {
        this.fastLane.close(msg.connectionId, 'superseded', false);
      }
      this.connectionTransport.set(msg.connectionId, 'relay');
      return this.handleClientMessage(msg, 'relay');
    });
    this.socket.on('client_disconnected', this.handleClientDisconnected.bind(this));

    // Fast Lane signaling. The relay only sends these after verifying the
    // account's subscription, and only for connections it is routing to us.
    this.socket.on('client_fast_lane', (msg: { connectionId: string; iceServers?: unknown }) => {
      // The config flag is re-read so turning Fast Lane off from the
      // dashboard refuses new offers without waiting for a restart.
      const enabled = this.config.fastLane?.enabled ?? true;
      if (!this.fastLaneSupported || !enabled || !msg?.connectionId) {
        if (msg?.connectionId) {
          this.socket?.emit('signal', { connectionId: msg.connectionId, data: { type: 'abort', reason: 'unsupported' } });
        }
        return;
      }
      this.fastLane.prepare(msg.connectionId, msg.iceServers).catch(() => {});
    });
    this.socket.on('client_signal', (msg: { connectionId: string; data: any }) => {
      if (!msg?.connectionId) return;
      this.fastLane.handleSignal(msg.connectionId, msg.data).catch(() => {});
    });

    // Error handling (async wrapper for handleError)
    this.socket.on('error', (error: ProxyErrorEvent) => {
      this.handleError(error).catch((err) => {
        console.error(`\n❌ ${t('connection.unhandledError')}`, err.message);
        process.exit(1);
      });
    });

    // Connection state. The `reconnect_*` events are Socket.IO built-ins —
    // since we disable its reconnection (`reconnection: false`) they never
    // fire; we call the same handlers from our custom scheduler instead.
    this.socket.on('disconnect', this.handleDisconnect.bind(this));
    this.socket.on('connect', () => this.notifyStatus());
    // Persistent connect_error handler covers reconnect-attempt failures.
    // Pre-auth failures are still owned by waitForAuthentication's
    // socket.once('connect_error', ...) listener — both fire, ours no-ops
    // until initialConnectAuthed flips to true.
    this.socket.on('connect_error', this.handleSocketConnectError.bind(this));
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
        const enhancedError: Error & { code?: string; retryAfter?: number } = new Error(
          `${t('connection.connectError', { message: error.message || error.toString() })}\n` +
          `  ${t('connection.connectErrorNamespace')}\n` +
          `  ${t('connection.connectErrorType', { type: error.type || 'unknown' })}`
        );
        // Forward code + retryAfter so the outer connect loop can branch on them
        // (e.g. wait + retry for rate_limited instead of falling to a different relay).
        enhancedError.code = error?.code;
        enhancedError.retryAfter = error?.retryAfter;
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

    this.tokenRefreshState = 'idle';

    // Successful auth — any pending reconnect cycle is done. Reset attempt
    // counter so the next disconnect starts the schedule fresh at 1s.
    this.initialConnectAuthed = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();

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
      secret = generateSecret(SECRET_LENGTH);
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
    this.notifyStatus();
  }

  /**
   * spck:// URL the editor scans to pair with this CLI, or null before auth
   */
  getConnectUrl(): string | null {
    if (!this.connectionSettings) return null;
    const { clientId, secret } = this.connectionSettings;
    let url = `spck://connect?clientId=${clientId}&secret=${secret}&rs=${encodeURIComponent(this.options.proxyServerUrl)}`;
    if (this.config.name) {
      url += `&name=${encodeURIComponent(this.config.name)}`;
    }
    return url;
  }

  getConnectionSettings(): ConnectionSettings | null {
    return this.connectionSettings;
  }

  /**
   * Snapshot of relay + editor connection state for the dashboard
   */
  getStatus(): ProxyStatus {
    const clients: ClientStatus[] = [];
    for (const [connectionId, connection] of this.activeConnections) {
      if (!connection.authenticated) continue;
      clients.push({
        connectionId,
        deviceId: connection.deviceId,
        transport: this.connectionTransport.get(connectionId) ?? connection.transport ?? 'relay',
        connectedAt: connection.connectedAt,
        ready: !!connection.handshakeComplete,
        pingMs: connection.pingMs ?? null,
      });
    }
    return {
      relayUrl: this.options.proxyServerUrl,
      relayConnected: !!this.socket?.connected,
      clientId: this.connectionSettings?.clientId,
      fastLane: this.fastLaneState,
      clients,
    };
  }

  /**
   * Subscribe to status changes. Returns an unsubscribe function.
   */
  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Editors attach their measured round trip to RPC requests as an optional,
   * unsigned `latency` field; read only after the request's HMAC checked out.
   */
  private recordEditorLatency(connection: ActiveConnection, latency: unknown): void {
    if (typeof latency !== 'number' || !Number.isFinite(latency) || latency < 0) return;
    const pingMs = Math.round(latency);
    if (connection.pingMs === pingMs) return;
    connection.pingMs = pingMs;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) {
      try { listener(); } catch { /* a broken listener must not break the relay */ }
    }
  }

  /**
   * Display QR code for client connection
   */
  private displayQRCode(): void {
    const url = this.getConnectUrl();
    if (!url || !this.connectionSettings) return;
    const { clientId, secret } = this.connectionSettings;

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
    console.log('-'.repeat(60) + '\n');
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
  private async handleClientMessage(msg: ProxyClientMessageEvent, transport: 'relay' | 'fastlane'): Promise<void> {
    const { connectionId, data } = msg;

    try {
      // Handle handshake protocol messages
      if (data.type) {
        await this.handleHandshakeMessage(connectionId, data, transport);
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
  private async handleHandshakeMessage(connectionId: string, data: any, transport: 'relay' | 'fastlane'): Promise<void> {
    switch (data.type) {
      case 'auth':
        await this.handleClientAuth(connectionId, data, transport);
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
   * A connection is pinned to the transport its auth handshake completed on.
   * Without this, a compromised relay could inject handshake messages for a
   * Fast Lane-authenticated connection over the relay path and pull its
   * traffic (e.g. broadcasts) back onto a channel the relay can read.
   */
  private isPinnedElsewhere(connectionId: string, transport: 'relay' | 'fastlane'): boolean {
    const connection = this.activeConnections.get(connectionId);
    if (!connection?.transport || connection.transport === transport) return false;
    logConnection('transport_mismatch_dropped', connection.deviceId, {
      connectionId,
      pinned: connection.transport,
      received: transport,
    });
    return true;
  }

  /**
   * Handle client HMAC authentication.
   *
   * On Fast Lane the editor's HMAC also covers the DTLS channel binding (both
   * certificate fingerprints), and we answer with our own HMAC proof over the
   * same binding. Each side signs the fingerprints it actually negotiated, so
   * a relay that substituted fingerprints in the SDP to sit in the middle
   * produces mismatched bindings and the handshake fails on both ends.
   */
  private async handleClientAuth(connectionId: string, authMessage: any, transport: 'relay' | 'fastlane'): Promise<void> {
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

      // Channel binding: required on Fast Lane, forbidden on the relay (an
      // editor that signed a binding believes it is on a direct connection,
      // so receiving it via the relay means someone is forwarding it).
      const expectedBinding = transport === 'fastlane' ? this.fastLane.channelBinding(connectionId) : null;
      if (transport === 'fastlane' && !expectedBinding) {
        throw new Error('Fast Lane channel binding unavailable');
      }
      if ((authMessage.channelBinding ?? null) !== expectedBinding) {
        throw new Error('Channel binding mismatch - possible man-in-the-middle on the connection');
      }

      // Verify HMAC signature (always includes deviceId, plus the binding on Fast Lane)
      const messageToVerify: Record<string, unknown> = { type: 'auth', clientId, timestamp, nonce, deviceId };
      if (expectedBinding) messageToVerify.channelBinding = expectedBinding;
      const expectedHmac = this.computeHMAC(messageToVerify, this.connectionSettings.secret);
      if (typeof hmac !== 'string' || hmac.length !== expectedHmac.length ||
          !crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) {
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
        transport,
      });
      this.notifyStatus();

      // Send success response. On Fast Lane, prove we hold the secret too and
      // saw the same DTLS fingerprints, so the editor can detect an impostor.
      const authResult: Record<string, unknown> = { type: 'auth_result', success: true };
      if (expectedBinding) {
        authResult.serverProof = this.computeHMAC(
          { timestamp, type: 'auth_proof', nonce, channelBinding: expectedBinding },
          this.connectionSettings.secret
        );
      }
      this.sendToClient(connectionId, 'handshake', authResult);

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
      // ACP transport (local Claude Code). The client uses this to decide
      // whether to expose the "Local Claude Code" transport switcher.
      // Model list is fetched separately via the `acp.capabilities` RPC.
      acp: this.tools.claude,
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
    this.notifyStatus();
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
      this.recordEditorLatency(connection, message.latency);

      // Route to appropriate service with socket wrapper
      const result = await RPCRouter.route(message as JSONRPCRequest, connection.socketWrapper as any);

      // If result is an async iterable, stream it as binary chunks (__binaryChunk protocol)
      if (result != null && typeof result[Symbol.asyncIterator] === 'function') {
        await this.sendBinaryChunked(connectionId, message.id ?? null, result);
        return;
      }

      // Send response
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        result,
        id: message.id ?? null,
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
        id: message.id ?? null,
      };

      this.sendToClient(connectionId, 'rpc', response);
    }
  }

  /**
   * Stream an async iterable of Buffers to the client using the __binaryChunk protocol.
   * Each chunk is sent as a Socket.IO binary attachment (no base64).
   * The client assembles chunks and resolves the pending RPC request.
   */
  private async sendBinaryChunked(
    connectionId: string,
    requestId: number | string | null,
    iterable: any
  ): Promise<void> {
    if (!this.socket) return;
    const chunkId = crypto.randomBytes(8).toString('hex');
    const total: number = iterable.totalChunks;
    const sizeMB = iterable.size ? `~${Math.round(iterable.size / 1024 / 1024 * 10) / 10}MB` : '?';
    console.log(`📦 Binary streaming: ${total} chunks (${sizeMB}) for request ${requestId}`);

    try {
      let index = 0;
      for await (const chunk of iterable) {
        // Bypass sendToClient/needsChunking — both transports carry Buffers
        // natively (Socket.IO attachments / Fast Lane binary blobs).
        this.emitRpcFrame(connectionId, {
          __binaryChunk: true,
          chunkId,
          requestId,
          index,
          total,
          data: chunk,
        });
        index++;
        if (this.connectionTransport.get(connectionId) === 'fastlane') {
          await this.fastLane.whenWritable(connectionId);
        }
      }
    } catch (error: any) {
      // Stream error — send a normal RPC error so the client rejects the pending request
      this.emitRpcFrame(connectionId, {
        jsonrpc: '2.0',
        id: requestId,
        error: createRPCError(ErrorCode.INTERNAL_ERROR, error.message || 'Binary stream error'),
      });
    }
  }

  /**
   * Emit a raw 'rpc' frame on the connection's current transport.
   */
  private emitRpcFrame(connectionId: string, data: any): void {
    if (this.connectionTransport.get(connectionId) === 'fastlane' &&
        this.fastLane.send(connectionId, 'rpc', data)) {
      return;
    }
    this.socket?.emit('rpc', { connectionId, data });
  }

  /**
   * Send message to client via Fast Lane when active, otherwise via proxy.
   * Relay payloads are chunked above 800kB; Fast Lane fragments internally.
   */
  private sendToClient(connectionId: string, event: string, data: any): void {
    if (this.connectionTransport.get(connectionId) === 'fastlane' &&
        this.fastLane.send(connectionId, event, data)) {
      return;
    }
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

    // Intentionally do NOT call cleanupTerminalService or cleanupAcpSessions
    // here — terminal PTYs and ACP agent subprocesses are deliberately kept
    // alive across disconnects so the user can reconnect (new tab, restored
    // session) and resume their work. Both services key state by deviceId,
    // and the client re-attaches on reconnect via `subscribe` (terminal) and
    // `acp.newSession` (which is idempotent on chatId).
    //
    // The trade-off: long-lived idle clients accumulate processes. If that
    // ever becomes the dominant cost, add an idle TTL on each service rather
    // than killing eagerly on disconnect.

    // Clean up connection tracking
    this.fastLane.close(data.connectionId, 'client_disconnected', false);
    this.connectionTransport.delete(data.connectionId);
    this.activeConnections.delete(data.connectionId);
    this.notifyStatus();
  }

  /**
   * Forget every editor session. Sessions never outlive the relay control
   * socket: the relay drops its editors when our socket goes (its
   * client_disconnected events can't reach a dead socket), and Fast Lane peers
   * must not outlive it since the relay is what enforces account limits.
   */
  private resetEditorSessions(): void {
    this.fastLane.closeAll();
    this.connectionTransport.clear();
    this.activeConnections.clear();
  }

  /**
   * Handle proxy error
   */
  private async handleError(error: ProxyErrorEvent): Promise<void> {
    // The server can emit multiple expired_firebase_token events during a reconnect
    // cycle; guard so only one refresh runs and duplicates are silently dropped.
    if (error.code === 'expired_firebase_token') {
      if (this.tokenRefreshState === 'refreshing') {
        return;
      }
      if (this.tokenRefreshState === 'idle') {
        console.warn(`\n⚠️  ${t('proxyError.firebaseTokenExpiring')}`);
        this.tokenRefreshState = 'refreshing';

        try {
          await this.refreshTokenAndReconnect();
          // handleAuthenticated already reset state to 'idle'
          return;
        } catch (refreshError: any) {
          this.tokenRefreshState = 'failed';
          console.error(`\n❌ ${t('proxyError.tokenRefreshFailed', { message: refreshError.message })}`);
          // Fall through to regular error handling
        }
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

      case 'rate_limited': {
        // Don't exit — the outer connect loop will wait and retry.
        const retryAfter = typeof error.retryAfter === 'number' && error.retryAfter > 0
          ? error.retryAfter
          : 60;
        this.suppressServerDisconnectExit = true;
        console.warn(`\n⏳ ${t('proxyError.rateLimited')}`);
        console.warn(`${t('proxyError.rateLimitedHint', { seconds: retryAfter })}\n`);
        return;
      }

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
        if (this.tokenRefreshState === 'failed') {
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
    // Suppress the disconnect noise when we know we're about to retry — the
    // rate_limited branch in handleError already logged the useful info.
    if (this.suppressServerDisconnectExit && reason === 'io server disconnect') {
      return;
    }

    console.warn(`\n⚠️  ${t('connection.disconnectedFromProxy', { reason })}`);
    this.resetEditorSessions();
    this.notifyStatus();

    // The relay rejects a reconnect carrying an expired Firebase token with
    // `expired_firebase_token` and then drops the socket. handleError is
    // already refreshing and will open a fresh socket; exiting here would
    // kill the process mid-refresh (e.g. after the machine slept > 1h).
    if (this.tokenRefreshState === 'refreshing') return;

    if (reason === 'io server disconnect') {
      // Server forcefully disconnected us
      console.error(`${t('connection.serverTerminated')}\n`);
      process.exit(1);
    }

    // We initiated this (graceful disconnect()) — don't auto-reconnect.
    if (reason === 'io client disconnect') return;

    // Pre-auth disconnects are owned by the outer connect loop, not our
    // scheduler. Once initial auth completed, drive reconnects ourselves.
    if (!this.initialConnectAuthed) return;

    console.log(t('connection.attemptingReconnect'));
    this.scheduleReconnect();
  }

  /**
   * Cancel any pending reconnect attempt. Safe to call when no timer is set.
   * Does NOT reset the attempt counter — the caller decides whether the
   * existing schedule is still meaningful (e.g. handleAuthenticated resets
   * the counter; cleanup paths just drop the timer).
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Full reset of the reconnect state machine. Used by paths that tear down
   * the socket and don't plan to resume from the prior schedule — without
   * this, a reused/relayed ProxyClient inherits a stale backoff index and
   * may jump straight to the schedule's last slot (60s) on its next
   * reconnect instead of starting at 1s.
   */
  private resetReconnectState(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.initialConnectAuthed = false;
  }

  /**
   * Schedule the next reconnect attempt using our custom backoff schedule.
   * No-op if a reconnect is already pending or we've exhausted attempts.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt >= ProxyClient.MAX_RECONNECT_ATTEMPTS) {
      this.handleReconnectFailed();
      return;
    }
    const scheduleIdx = Math.min(
      this.reconnectAttempt,
      ProxyClient.RECONNECT_SCHEDULE_MS.length - 1
    );
    const delay = ProxyClient.RECONNECT_SCHEDULE_MS[scheduleIdx];
    this.reconnectAttempt++;
    const attemptNumber = this.reconnectAttempt;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.handleReconnectAttempt(attemptNumber);
      try {
        this.socket?.connect();
      } catch {
        // socket.connect() shouldn't throw — but if it does, schedule the
        // next attempt rather than wedging the loop.
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Reconnect-attempt failure handler. waitForAuthentication owns the
   * pre-auth case via its `once('connect_error', ...)` listener.
   */
  private handleSocketConnectError(_error: Error): void {
    if (!this.initialConnectAuthed) return;
    this.scheduleReconnect();
  }

  /**
   * Handle reconnection attempt
   */
  private handleReconnectAttempt(attemptNumber: number): void {
    console.log(`🔄 ${t('connection.reconnectAttempt', { attempt: attemptNumber, max: ProxyClient.MAX_RECONNECT_ATTEMPTS })}`);
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
   * Tear down the socket immediately without the graceful kill handshake.
   * Used to clean up after a failed initial connect attempt so we can retry
   * against a different relay without leaving a reconnecting socket behind.
   */
  forceCleanup(): void {
    this.resetReconnectState();
    this.resetEditorSessions();
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  /**
   * Graceful disconnect from proxy
   */
  async disconnect(): Promise<void> {
    this.resetReconnectState();
    this.resetEditorSessions();
    if (!this.socket) return;

    RPCRouter.cleanup();
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
