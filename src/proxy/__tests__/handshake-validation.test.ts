import { describe, it, expect } from 'vitest';
/**
 * Tests for handshake validation - Replay attack prevention
 */

import { validateHandshakeTimestamp } from '../handshake-validation.js';

describe('validateHandshakeTimestamp - Replay Attack Prevention', () => {
  const ONE_MINUTE = 60 * 1000;
  const NOW = 1640000000000; // Fixed timestamp for testing

  describe('Valid timestamps', () => {
    it('should accept message with current timestamp', () => {
      const result = validateHandshakeTimestamp(NOW, { now: NOW });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept message 30 seconds old', () => {
      const timestamp = NOW - 30 * 1000;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept message exactly 1 minute old (boundary)', () => {
      const timestamp = NOW - ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept message 59 seconds old', () => {
      const timestamp = NOW - 59 * 1000;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept message 30 seconds in future (clock skew)', () => {
      const timestamp = NOW + 30 * 1000;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept message exactly 1 minute in future (clock skew boundary)', () => {
      const timestamp = NOW + ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept message 59 seconds in future', () => {
      const timestamp = NOW + 59 * 1000;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Invalid timestamps - Too old', () => {
    it('should reject message 2 minutes old', () => {
      const timestamp = NOW - 2 * ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
      expect(result.error).toContain('120s'); // 2 minutes
    });

    it('should reject message 5 minutes old', () => {
      const timestamp = NOW - 5 * ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
      expect(result.error).toContain('300s'); // 5 minutes
    });

    it('should reject message 1 minute and 1 millisecond old', () => {
      const timestamp = NOW - ONE_MINUTE - 1;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
    });

    it('should reject message 61 seconds old', () => {
      const timestamp = NOW - 61 * 1000;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
    });

    it('should reject very old message (1 hour)', () => {
      const timestamp = NOW - 60 * ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
    });
  });

  describe('Invalid timestamps - Too far in future', () => {
    it('should reject message 2 minutes in future', () => {
      const timestamp = NOW + 2 * ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too far in future');
      expect(result.error).toContain('120s'); // 2 minutes
    });

    it('should reject message 5 minutes in future', () => {
      const timestamp = NOW + 5 * ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too far in future');
    });

    it('should reject message 1 minute and 1 millisecond in future', () => {
      const timestamp = NOW + ONE_MINUTE + 1;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too far in future');
    });

    it('should reject message 61 seconds in future', () => {
      const timestamp = NOW + 61 * 1000;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too far in future');
    });
  });

  describe('Invalid timestamp formats', () => {
    it('should reject non-number timestamp', () => {
      const result = validateHandshakeTimestamp('invalid' as any, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid timestamp format');
    });

    it('should reject NaN timestamp', () => {
      const result = validateHandshakeTimestamp(NaN, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid timestamp format');
    });

    it('should reject Infinity timestamp', () => {
      const result = validateHandshakeTimestamp(Infinity, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid timestamp format');
    });

    it('should reject negative timestamp', () => {
      const result = validateHandshakeTimestamp(-1000, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Timestamp must be positive');
    });

    it('should reject zero timestamp', () => {
      const result = validateHandshakeTimestamp(0, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Timestamp must be positive');
    });

    it('should reject null timestamp', () => {
      const result = validateHandshakeTimestamp(null as any, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid timestamp format');
    });

    it('should reject undefined timestamp', () => {
      const result = validateHandshakeTimestamp(undefined as any, { now: NOW });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid timestamp format');
    });
  });

  describe('Custom options', () => {
    it('should accept custom maxAge (5 minutes)', () => {
      const timestamp = NOW - 3 * ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, {
        now: NOW,
        maxAge: 5 * ONE_MINUTE,
      });

      expect(result.valid).toBe(true);
    });

    it('should reject with custom maxAge (30 seconds)', () => {
      const timestamp = NOW - 45 * 1000;
      const result = validateHandshakeTimestamp(timestamp, {
        now: NOW,
        maxAge: 30 * 1000,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
    });

    it('should accept custom clockSkewTolerance (2 minutes)', () => {
      const timestamp = NOW + 90 * 1000;
      const result = validateHandshakeTimestamp(timestamp, {
        now: NOW,
        clockSkewTolerance: 2 * ONE_MINUTE,
      });

      expect(result.valid).toBe(true);
    });

    it('should reject with custom clockSkewTolerance (30 seconds)', () => {
      const timestamp = NOW + 45 * 1000;
      const result = validateHandshakeTimestamp(timestamp, {
        now: NOW,
        clockSkewTolerance: 30 * 1000,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too far in future');
    });
  });

  describe('Replay attack scenarios', () => {
    it('should prevent replay of 2-minute-old captured message', () => {
      // Simulate attacker capturing a message and replaying it 2 minutes later
      const capturedTimestamp = NOW - 2 * ONE_MINUTE;
      const replayTime = NOW;

      const result = validateHandshakeTimestamp(capturedTimestamp, { now: replayTime });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
    });

    it('should prevent replay of 5-minute-old captured message', () => {
      // Simulate attacker capturing a message and replaying it 5 minutes later
      const capturedTimestamp = NOW - 5 * ONE_MINUTE;
      const replayTime = NOW;

      const result = validateHandshakeTimestamp(capturedTimestamp, { now: replayTime });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
    });

    it('should allow legitimate message sent 30 seconds ago', () => {
      // Simulate legitimate slow network (30 second delay)
      const sentTimestamp = NOW - 30 * 1000;
      const receiveTime = NOW;

      const result = validateHandshakeTimestamp(sentTimestamp, { now: receiveTime });

      expect(result.valid).toBe(true);
    });

    it('should prevent attacker from using far-future timestamp', () => {
      // Attacker tries to use timestamp far in future to extend validity
      const attackTimestamp = NOW + 10 * ONE_MINUTE;
      const receiveTime = NOW;

      const result = validateHandshakeTimestamp(attackTimestamp, { now: receiveTime });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too far in future');
    });
  });

  describe('Edge cases and boundaries', () => {
    it('should handle message at exact maxAge boundary', () => {
      const timestamp = NOW - ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, {
        now: NOW,
        maxAge: ONE_MINUTE,
      });

      expect(result.valid).toBe(true);
    });

    it('should handle message at exact clockSkewTolerance boundary', () => {
      const timestamp = NOW + ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, {
        now: NOW,
        clockSkewTolerance: ONE_MINUTE,
      });

      expect(result.valid).toBe(true);
    });

    it('should reject message 1ms past maxAge boundary', () => {
      const timestamp = NOW - ONE_MINUTE - 1;
      const result = validateHandshakeTimestamp(timestamp, {
        now: NOW,
        maxAge: ONE_MINUTE,
      });

      expect(result.valid).toBe(false);
    });

    it('should reject message 1ms past clockSkewTolerance boundary', () => {
      const timestamp = NOW + ONE_MINUTE + 1;
      const result = validateHandshakeTimestamp(timestamp, {
        now: NOW,
        clockSkewTolerance: ONE_MINUTE,
      });

      expect(result.valid).toBe(false);
    });

    it('should handle very recent timestamp (1ms old)', () => {
      const timestamp = NOW - 1;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(true);
    });

    it('should handle very recent future timestamp (1ms ahead)', () => {
      const timestamp = NOW + 1;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.valid).toBe(true);
    });
  });

  describe('Error messages', () => {
    it('should provide detailed error for old message', () => {
      const timestamp = NOW - 2 * ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.error).toContain('age: 120s');
      expect(result.error).toContain('max: 60s');
    });

    it('should provide detailed error for future message', () => {
      const timestamp = NOW + 2 * ONE_MINUTE;
      const result = validateHandshakeTimestamp(timestamp, { now: NOW });

      expect(result.error).toContain('skew: 120s');
      expect(result.error).toContain('max: 60s');
    });

    it('should provide clear error for invalid format', () => {
      const result = validateHandshakeTimestamp('not-a-number' as any, { now: NOW });

      expect(result.error).toBe('Invalid timestamp format');
    });
  });
});
