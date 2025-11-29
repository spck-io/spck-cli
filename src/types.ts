/**
 * Core type definitions for spck-networking server
 */

import { Socket } from 'socket.io';

// Server Configuration
export interface ServerConfig {
  version: number;
  port: number;
  root: string;
  allowedUids: string[];
  signingKey?: string;
  firebaseProjectId: string;
  terminal: {
    maxBufferedLines: number;
    maxTerminals: number;
  };
  filesystem: {
    maxFileSize: string;
    watchIgnorePatterns: string[];
  };
}

// JSON-RPC 2.0 Types
export interface JSONRPCRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id?: number | string;
  timestamp?: number;
  hmac?: string;
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

// Socket with user data
export interface AuthenticatedSocket extends Socket {
  data: {
    uid: string;
  };
}

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
}

// Helper to create JSON-RPC error
export function createRPCError(
  code: ErrorCode,
  message: string,
  data?: any
): JSONRPCError {
  return { code, message, data };
}
