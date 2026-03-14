/**
 * Core type definitions for spck-cli server
 */

// Minimal Socket interface for our needs (not dependent on socket.io)
export interface SocketInterface {
  id: string;
  emit(event: string, data?: any): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  broadcast: {
    emit(event: string, data?: any): boolean;
  };
  data: {
    uid: string;       // CLI user ID (from Firebase auth)
    deviceId: string;  // Mobile device ID (identifies the specific device)
  };
}

// Server Configuration
export interface ServerConfig {
  version: number;
  root: string;
  name?: string; // Optional: Friendly name for QR code identification

  terminal: {
    enabled: boolean;
    maxBufferedLines: number;
    maxTerminals: number;
  };

  security: {
    userAuthenticationEnabled: boolean;
  };

  filesystem: {
    maxFileSize: string;
    watchIgnorePatterns: string[];
  };
}

// Connection Settings (stored in .spck-editor/config/connection-settings.json)
export interface ConnectionSettings {
  serverToken: string;
  serverTokenExpiry: number;
  clientId: string;
  secret: string;
  userId: string;
  connectedAt: number;
}

// Stored credentials (persisted to ~/.spck-editor/.credentials.json)
// Only refreshToken and userId are persisted - firebaseToken is generated on demand
export interface StoredCredentials {
  refreshToken: string;
  userId: string;
  proxyServerUrl?: string;
}

// Firebase Credentials (runtime - includes ephemeral ID token)
export interface FirebaseCredentials {
  firebaseToken: string;
  firebaseTokenExpiry: number;
  refreshToken: string;
  userId: string;
}

// JSON-RPC 2.0 Types
export interface JSONRPCRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id?: number | string;
  timestamp?: number;
  hmac: string;
  nonce: string;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: JSONRPCError;
  id: number | string | null;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: any;
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

// JWT Payload
export interface JWTPayload {
  aud: string;
  iat: number;
  exp: number;
  iss: string;
  sub: string;
  [key: string]: any;
}

// Socket with user data (extends our minimal socket interface)
export interface AuthenticatedSocket extends SocketInterface {}

// Error codes (JSON-RPC 2.0 + custom)
export enum ErrorCode {
  // Standard JSON-RPC 2.0
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,

  // Authentication & Security
  AUTHENTICATION_FAILED = -32001,
  JWT_EXPIRED = -32002,
  HMAC_VALIDATION_FAILED = -32003,
  PERMISSION_DENIED = -32005,

  // Filesystem
  FILE_NOT_FOUND = -32004,
  WRITE_CONFLICT = -32006,
  INVALID_PATH = -32007,
  FILE_TOO_LARGE = -32031,
  INVALID_ENCODING = -32032,
  DELTA_PATCH_FAILED = -32033,

  // Git
  GIT_OPERATION_FAILED = -32010,
  INVALID_OID = -32011,
  REPOSITORY_NOT_FOUND = -32012,

  // Terminal
  TERMINAL_NOT_FOUND = -32020,
  TERMINAL_LIMIT_EXCEEDED = -32021,
  TERMINAL_PROCESS_EXITED = -32022,

  // General
  OPERATION_TIMEOUT = -32030,
  UID_NOT_AUTHORIZED = -32040,
  FEATURE_DISABLED = -32041,
}

// Helper to create JSON-RPC error
export function createRPCError(
  code: ErrorCode,
  message: string,
  data?: any
): JSONRPCError {
  return { code, message, data };
}

// Proxy Protocol Messages

// Handshake protocol message types
export type HandshakeMessageType =
  | 'auth'
  | 'auth_result'
  | 'request_user_verification'
  | 'user_verification'
  | 'protocol_info'
  | 'protocol_selected'
  | 'connected';

// Client authentication message (JWT signed with shared secret)
export interface ClientAuthMessage {
  type: 'auth';
  jwt: string;
}

// Auth result message (CLI -> Client)
export interface AuthResultMessage {
  type: 'auth_result';
  success: boolean;
  error?: string;
}

// User verification request (CLI -> Client)
export interface UserVerificationRequestMessage {
  type: 'request_user_verification';
  message: string;
}

// User verification response (Client -> CLI)
export interface UserVerificationMessage {
  type: 'user_verification';
  firebaseToken: string;
}

// Protocol info message (CLI -> Client)
export interface ProtocolInfoMessage {
  type: 'protocol_info';
  minVersion: number;
  maxVersion: number;
  features: {
    terminal: boolean;
    git: boolean;
    fastSearch: boolean;
  };
}

// Protocol selected message (Client -> CLI)
export interface ProtocolSelectedMessage {
  type: 'protocol_selected';
  version: number;
  ready: boolean;
}

// Connection established message (CLI -> Client)
export interface ConnectedMessage {
  type: 'connected';
  message: string;
}

// Union type for all handshake messages
export type HandshakeMessage =
  | ClientAuthMessage
  | AuthResultMessage
  | UserVerificationRequestMessage
  | UserVerificationMessage
  | ProtocolInfoMessage
  | ProtocolSelectedMessage
  | ConnectedMessage;

// Proxy server events (from server to CLI)
export interface ProxyAuthenticatedEvent {
  token: string;
  clientId: string;
  userId: string;
  expiresAt: number;
}

export interface ProxyClientConnectingEvent {
  connectionId: string;
}

export interface ProxyMultipleConnectionEvent {
  existingConnections: string[];
  newConnectionId: string;
}

export interface ProxyClientMessageEvent {
  connectionId: string;
  data: any;
}

export interface ProxyClientDisconnectedEvent {
  connectionId: string;
  reason?: string;
}

export interface ProxyErrorEvent {
  code: string;
  message: string;
  [key: string]: any;
}

// Tool detection result
export interface ToolDetectionResult {
  git: boolean;
  ripgrep: boolean;
}
