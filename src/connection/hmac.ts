/**
 * HMAC message signing validation
 */

import * as crypto from 'crypto';
import { JSONRPCRequest, ErrorCode, createRPCError } from '../types';

/**
 * Validate HMAC signature on JSON-RPC request
 */
export function validateHMAC(message: JSONRPCRequest, signingKey: string): boolean {
  if (!message.hmac || !message.timestamp) {
    return false;
  }

  // Reconstruct the message that was signed
  const payload = {
    jsonrpc: message.jsonrpc,
    method: message.method,
    params: message.params,
    id: message.id,
  };

  const messageToSign = message.timestamp + JSON.stringify(payload);

  // Compute HMAC
  const expectedHmac = crypto
    .createHmac('sha256', signingKey)
    .update(messageToSign)
    .digest('hex');

  // Check lengths match before constant-time comparison
  if (message.hmac.length !== expectedHmac.length) {
    return false;
  }

  // Compare with provided HMAC (constant-time comparison)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(message.hmac),
      Buffer.from(expectedHmac)
    );
  } catch {
    return false;
  }
}

/**
 * Validate HMAC or throw error
 */
export function requireValidHMAC(message: JSONRPCRequest, signingKey: string): void {
  if (!validateHMAC(message, signingKey)) {
    throw createRPCError(
      ErrorCode.HMAC_VALIDATION_FAILED,
      'HMAC validation failed - message signature invalid or missing'
    );
  }

  // Check timestamp is recent (within 5 minutes)
  if (message.timestamp) {
    const now = Date.now();
    const age = now - message.timestamp;
    const maxAge = 5 * 60 * 1000; // 5 minutes

    if (age > maxAge || age < -60000) {
      // Allow 1 minute clock skew
      throw createRPCError(
        ErrorCode.HMAC_VALIDATION_FAILED,
        'Message timestamp too old or invalid',
        { timestamp: message.timestamp, serverTime: now }
      );
    }
  }
}
