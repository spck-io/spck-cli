/**
 * HMAC message signing validation with replay attack prevention
 */

import * as crypto from 'crypto';
import { JSONRPCRequest, ErrorCode, createRPCError } from '../types.js';

/**
 * Nonce tracking to prevent replay attacks
 * Stores nonces with their expiry timestamps
 */
const seenNonces = new Map<string, number>();

/**
 * Clean up expired nonces from the tracking map
 */
function cleanExpiredNonces(): void {
  const now = Date.now();
  for (const [nonce, expiry] of seenNonces.entries()) {
    if (expiry < now) {
      seenNonces.delete(nonce);
    }
  }
}

/**
 * Get statistics about nonce tracking (for testing/monitoring)
 */
export function getNonceStats(): { total: number; active: number } {
  const now = Date.now();
  let active = 0;
  for (const expiry of seenNonces.values()) {
    if (expiry >= now) {
      active++;
    }
  }
  return { total: seenNonces.size, active };
}

/**
 * Clear all tracked nonces (for testing)
 */
export function clearNonces(): void {
  seenNonces.clear();
}

/**
 * Validate HMAC signature on JSON-RPC request
 */
export function validateHMAC(message: JSONRPCRequest, signingKey: string): boolean {
  if (!message.hmac || !message.timestamp) {
    return false;
  }

  // Reconstruct the message that was signed (must match client's _computeHMAC)
  // Client uses: const { timestamp, hmac, ...rest } = request
  // So we need to include all fields except timestamp and hmac
  // Strip any Buffer values from params before JSON.stringify,
  // since they serialize inconsistently across environments. Both sides must do this.
  let params = message.params;
  if (params && typeof params === 'object') {
    const cleanParams: any = {};
    for (const [k, v] of Object.entries(params)) {
      if (!Buffer.isBuffer(v)) {
        cleanParams[k] = v;
      }
    }
    params = cleanParams;
  }

  const payload: any = {
    jsonrpc: message.jsonrpc,
    method: message.method,
    params,
    id: message.id,
    nonce: message.nonce
  };

  // Include deviceId if present (client includes it)
  if ('deviceId' in message) {
    payload.deviceId = (message as any).deviceId;
  }

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

  // Check timestamp is recent (within 2 minutes)
  if (message.timestamp) {
    const now = Date.now();
    const age = now - message.timestamp;
    const maxAge = 2 * 60 * 1000; // 2 minutes (reduced from 5 to mitigate replay attacks)

    if (age > maxAge || age < -60000) {
      // Allow 1 minute clock skew
      throw createRPCError(
        ErrorCode.HMAC_VALIDATION_FAILED,
        'Message timestamp too old or invalid',
        { timestamp: message.timestamp, serverTime: now }
      );
    }
  }

  // Check nonce to prevent replay attacks
  if (seenNonces.has(message.nonce)) {
    throw createRPCError(
      ErrorCode.HMAC_VALIDATION_FAILED,
      'Duplicate nonce detected - possible replay attack',
      { nonce: message.nonce }
    );
  }

  // Store nonce with expiry (2 minutes from now)
  const maxAge = 2 * 60 * 1000;
  seenNonces.set(message.nonce, Date.now() + maxAge);

  // Clean up expired nonces periodically
  if (seenNonces.size > 1000) {
    cleanExpiredNonces();
  }
}
