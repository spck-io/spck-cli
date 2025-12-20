/**
 * Handshake validation utilities
 * Provides timestamp validation for replay attack prevention
 */

/**
 * Validate timestamp from client handshake message
 * Prevents replay attacks by ensuring messages are recent
 *
 * @param timestamp - Unix timestamp in milliseconds from client message
 * @param options - Validation options
 * @returns Validation result with error message if invalid
 */
export function validateHandshakeTimestamp(
  timestamp: number,
  options: {
    maxAge?: number; // Maximum age in milliseconds (default: 1 minute)
    clockSkewTolerance?: number; // Future tolerance in milliseconds (default: 1 minute)
    now?: number; // Current time for testing (default: Date.now())
  } = {}
): { valid: boolean; error?: string } {
  const {
    maxAge = 60 * 1000, // 1 minute default
    clockSkewTolerance = 60 * 1000, // 1 minute default
    now = Date.now(),
  } = options;

  // Validate timestamp is a number
  if (typeof timestamp !== 'number' || !isFinite(timestamp)) {
    return {
      valid: false,
      error: 'Invalid timestamp format',
    };
  }

  // Validate timestamp is positive
  if (timestamp <= 0) {
    return {
      valid: false,
      error: 'Timestamp must be positive',
    };
  }

  // Calculate age
  const age = now - timestamp;

  // Check if message is too old
  if (age > maxAge) {
    return {
      valid: false,
      error: `Message too old (age: ${Math.floor(age / 1000)}s, max: ${Math.floor(maxAge / 1000)}s)`,
    };
  }

  // Check if timestamp is too far in the future (clock skew)
  if (age < -clockSkewTolerance) {
    return {
      valid: false,
      error: `Timestamp too far in future (skew: ${Math.floor(-age / 1000)}s, max: ${Math.floor(clockSkewTolerance / 1000)}s)`,
    };
  }

  return { valid: true };
}
