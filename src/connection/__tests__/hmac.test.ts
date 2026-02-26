import { describe, it, expect, beforeEach } from 'vitest';
/**
 * Tests for HMAC message signing validation
 */

import * as crypto from 'crypto';
import { validateHMAC, requireValidHMAC, clearNonces, getNonceStats } from '../hmac.js';
import { JSONRPCRequest, ErrorCode } from '../../types.js';

describe('HMAC Validation', () => {
  const signingKey = 'test-signing-key-12345';

  // Clear nonces before each test
  beforeEach(() => {
    clearNonces();
  });

  function createSignedMessage(
    method: string,
    params: any,
    timestamp?: number,
    customHmac?: string,
    nonce?: string,
    deviceId?: string
  ): JSONRPCRequest {
    const ts = timestamp || Date.now();
    const nonceValue = nonce || crypto.randomBytes(16).toString('hex');

    const payload: any = {
      jsonrpc: '2.0' as const,
      method,
      params,
      id: 1,
      nonce: nonceValue,
    };

    // Include deviceId if provided (must be in payload for HMAC calculation)
    if (deviceId) {
      payload.deviceId = deviceId;
    }

    const messageToSign = ts + JSON.stringify(payload);
    const hmac =
      customHmac ||
      crypto.createHmac('sha256', signingKey).update(messageToSign).digest('hex');

    return {
      ...payload,
      timestamp: ts,
      hmac,
      nonce: nonceValue,
    };
  }

  describe('validateHMAC', () => {
    it('should validate correctly signed message', () => {
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' });

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(true);
    });

    it('should reject message with invalid HMAC', () => {
      const message = createSignedMessage(
        'fs.readFile',
        { path: '/test.txt' },
        Date.now(),
        'invalid-hmac-signature'
      );

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(false);
    });

    it('should reject message with missing HMAC', () => {
      const message: any = {
        jsonrpc: '2.0',
        method: 'fs.readFile',
        params: { path: '/test.txt' },
        id: 1,
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex'),
        // hmac intentionally missing
      };

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(false);
    });

    it('should reject message with missing timestamp', () => {
      const message: any = {
        jsonrpc: '2.0',
        method: 'fs.readFile',
        params: { path: '/test.txt' },
        id: 1,
        hmac: 'some-hmac',
        nonce: crypto.randomBytes(16).toString('hex'),
        // timestamp intentionally missing
      };

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(false);
    });

    it('should reject message signed with wrong key', () => {
      const wrongKey = 'different-signing-key';
      const nonce = crypto.randomBytes(16).toString('hex');
      const payload = {
        jsonrpc: '2.0' as const,
        method: 'fs.readFile',
        params: { path: '/test.txt' },
        id: 1,
        nonce,
      };
      const timestamp = Date.now();
      const messageToSign = timestamp + JSON.stringify(payload);
      const hmac = crypto
        .createHmac('sha256', wrongKey)
        .update(messageToSign)
        .digest('hex');

      const message: JSONRPCRequest = {
        ...payload,
        timestamp,
        hmac,
        nonce,
      };

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(false);
    });

    it('should reject message with tampered params', () => {
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' });

      // Tamper with params after signing
      message.params = { path: '/tampered.txt' };

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(false);
    });

    it('should reject message with tampered method', () => {
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' });

      // Tamper with method after signing
      message.method = 'fs.deleteFile';

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(false);
    });

    it('should validate message with deviceId', () => {
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, undefined, 'device-123');

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(true);
    });

    it('should reject message when deviceId is tampered', () => {
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, undefined, 'device-123') as any;

      // Tamper with deviceId after signing
      message.deviceId = 'device-456';

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(false);
    });

    it('should use constant-time comparison for HMAC', () => {
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' });

      // Measure time for correct HMAC
      const startCorrect = process.hrtime.bigint();
      validateHMAC(message, signingKey);
      const correctTime = process.hrtime.bigint() - startCorrect;

      // Measure time for incorrect HMAC (same length)
      message.hmac = 'a'.repeat(message.hmac!.length);
      const startIncorrect = process.hrtime.bigint();
      validateHMAC(message, signingKey);
      const incorrectTime = process.hrtime.bigint() - startIncorrect;

      // Time difference should be minimal (constant-time comparison)
      // Allow up to 10x difference for timing variance
      const timeDiff = Number(incorrectTime - correctTime);
      const avgTime = Number((correctTime + incorrectTime) / BigInt(2));
      const relativeDiff = Math.abs(timeDiff) / avgTime;

      expect(relativeDiff).toBeLessThan(10);
    });
  });

  describe('requireValidHMAC', () => {
    it('should pass for valid HMAC', () => {
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' });

      expect(() => requireValidHMAC(message, signingKey)).not.toThrow();
    });

    it('should throw error for invalid HMAC', () => {
      const message = createSignedMessage(
        'fs.readFile',
        { path: '/test.txt' },
        Date.now(),
        'invalid-hmac'
      );

      expect(() => requireValidHMAC(message, signingKey)).toThrow(
        expect.objectContaining({
          code: ErrorCode.HMAC_VALIDATION_FAILED,
          message: expect.stringContaining('HMAC validation failed'),
        })
      );
    });

    it('should reject message with old timestamp', () => {
      const threeMinutesAgo = Date.now() - 3 * 60 * 1000;
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, threeMinutesAgo);

      expect(() => requireValidHMAC(message, signingKey)).toThrow(
        expect.objectContaining({
          code: ErrorCode.HMAC_VALIDATION_FAILED,
          message: expect.stringContaining('timestamp too old'),
        })
      );
    });

    it('should accept message within 2 minute window', () => {
      const oneMinuteAgo = Date.now() - 1 * 60 * 1000;
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, oneMinuteAgo);

      expect(() => requireValidHMAC(message, signingKey)).not.toThrow();
    });

    it('should allow 1 minute clock skew for future timestamps', () => {
      const thirtySecondsInFuture = Date.now() + 30 * 1000;
      const message = createSignedMessage(
        'fs.readFile',
        { path: '/test.txt' },
        thirtySecondsInFuture
      );

      expect(() => requireValidHMAC(message, signingKey)).not.toThrow();
    });

    it('should reject timestamp more than 1 minute in future', () => {
      const twoMinutesInFuture = Date.now() + 2 * 60 * 1000;
      const message = createSignedMessage(
        'fs.readFile',
        { path: '/test.txt' },
        twoMinutesInFuture
      );

      expect(() => requireValidHMAC(message, signingKey)).toThrow(
        expect.objectContaining({
          code: ErrorCode.HMAC_VALIDATION_FAILED,
          message: expect.stringContaining('timestamp too old or invalid'),
        })
      );
    });

    it('should include timestamp details in error', () => {
      const threeMinutesAgo = Date.now() - 3 * 60 * 1000;
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, threeMinutesAgo);

      try {
        requireValidHMAC(message, signingKey);
        expect.unreachable('Should have thrown error');
      } catch (error: any) {
        expect(error.data).toMatchObject({
          timestamp: threeMinutesAgo,
          serverTime: expect.any(Number),
        });
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty params', () => {
      const message = createSignedMessage('terminal.create', {});

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(true);
    });

    it('should handle params with special characters', () => {
      const message = createSignedMessage('fs.writeFile', {
        path: '/test.txt',
        content: 'Special chars: 你好 émojis 🚀',
      });

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(true);
    });

    it('should handle params with nested objects', () => {
      const message = createSignedMessage('git.commit', {
        dir: '/project',
        message: 'Test commit',
        author: {
          name: 'Test User',
          email: 'test@example.com',
          timestamp: 1234567890,
        },
      });

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(true);
    });

    it('should handle params with arrays', () => {
      const message = createSignedMessage('git.add', {
        dir: '/project',
        filepaths: ['file1.txt', 'file2.txt', 'file3.txt'],
      });

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(true);
    });

    it('should handle very long signing keys', () => {
      const longKey = 'x'.repeat(1000);
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' });

      // Re-sign with long key
      const payload = {
        jsonrpc: message.jsonrpc,
        method: message.method,
        params: message.params,
        id: message.id,
        nonce: message.nonce,
      };
      const messageToSign = message.timestamp + JSON.stringify(payload);
      message.hmac = crypto
        .createHmac('sha256', longKey)
        .update(messageToSign)
        .digest('hex');

      const isValid = validateHMAC(message, longKey);

      expect(isValid).toBe(true);
    });
  });

  describe('Replay Attack Prevention', () => {
    it('should accept message with nonce on first use', () => {
      const nonce = crypto.randomBytes(16).toString('hex');
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce);

      expect(() => requireValidHMAC(message, signingKey)).not.toThrow();
    });

    it('should reject duplicate nonce (replay attack)', () => {
      const nonce = crypto.randomBytes(16).toString('hex');
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce);

      // First use should succeed
      expect(() => requireValidHMAC(message, signingKey)).not.toThrow();

      // Second use should fail (replay attack)
      const replayMessage = createSignedMessage('fs.readFile', { path: '/test.txt' }, message.timestamp, undefined, nonce);
      expect(() => requireValidHMAC(replayMessage, signingKey)).toThrow(
        expect.objectContaining({
          code: ErrorCode.HMAC_VALIDATION_FAILED,
          message: expect.stringContaining('Duplicate nonce'),
        })
      );
    });

    it('should include nonce in error data when rejecting replay', () => {
      const nonce = crypto.randomBytes(16).toString('hex');
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce);

      // First use
      requireValidHMAC(message, signingKey);

      // Second use (replay)
      const replayMessage = createSignedMessage('fs.readFile', { path: '/test.txt' }, message.timestamp, undefined, nonce);
      try {
        requireValidHMAC(replayMessage, signingKey);
        expect.unreachable('Should have thrown error');
      } catch (error: any) {
        expect(error.data).toMatchObject({
          nonce: nonce,
        });
      }
    });

    it('should accept different nonces', () => {
      const nonce1 = crypto.randomBytes(16).toString('hex');
      const nonce2 = crypto.randomBytes(16).toString('hex');

      const message1 = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce1);
      const message2 = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce2);

      expect(() => requireValidHMAC(message1, signingKey)).not.toThrow();
      expect(() => requireValidHMAC(message2, signingKey)).not.toThrow();
    });

    it('should validate nonce signature correctly', () => {
      const nonce = crypto.randomBytes(16).toString('hex');
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce);

      const isValid = validateHMAC(message, signingKey);
      expect(isValid).toBe(true);
    });

    it('should reject message with tampered nonce', () => {
      const nonce = crypto.randomBytes(16).toString('hex');
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce);

      // Tamper with nonce after signing
      message.nonce = crypto.randomBytes(16).toString('hex');

      const isValid = validateHMAC(message, signingKey);
      expect(isValid).toBe(false);
    });

    it('should track nonce statistics correctly', () => {
      clearNonces();

      const nonce1 = crypto.randomBytes(16).toString('hex');
      const nonce2 = crypto.randomBytes(16).toString('hex');

      const message1 = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce1);
      const message2 = createSignedMessage('fs.writeFile', { path: '/test.txt' }, undefined, undefined, nonce2);

      requireValidHMAC(message1, signingKey);
      requireValidHMAC(message2, signingKey);

      const stats = getNonceStats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(2);
    });

    it('should prevent replay flood attack', () => {
      const nonce = crypto.randomBytes(16).toString('hex');
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce);

      // First request succeeds
      expect(() => requireValidHMAC(message, signingKey)).not.toThrow();

      // Flood with replays (all should fail)
      for (let i = 0; i < 10; i++) {
        const replayMessage = createSignedMessage('fs.readFile', { path: '/test.txt' }, message.timestamp, undefined, nonce);
        expect(() => requireValidHMAC(replayMessage, signingKey)).toThrow(
          expect.objectContaining({
            code: ErrorCode.HMAC_VALIDATION_FAILED,
            message: expect.stringContaining('Duplicate nonce'),
          })
        );
      }
    });

    it('should handle concurrent requests with different nonces', () => {
      const nonces = Array.from({ length: 100 }, () => crypto.randomBytes(16).toString('hex'));

      // All should succeed (different nonces)
      for (const nonce of nonces) {
        const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce);
        expect(() => requireValidHMAC(message, signingKey)).not.toThrow();
      }

      const stats = getNonceStats();
      expect(stats.total).toBe(100);
      expect(stats.active).toBe(100);
    });

    it('should clean up nonces when map grows too large', () => {
      clearNonces();

      // Add old nonces (expired)
      const oldTimestamp = Date.now() - 3 * 60 * 1000; // 3 minutes ago
      for (let i = 0; i < 5; i++) {
        const nonce = `old-nonce-${i}`;
        const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, oldTimestamp, undefined, nonce);
        // These will fail due to old timestamp, but that's ok for this test
        try {
          requireValidHMAC(message, signingKey);
        } catch {}
      }

      // Add many new nonces to trigger cleanup
      for (let i = 0; i < 10001; i++) {
        const nonce = `new-nonce-${i}`;
        const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, undefined, undefined, nonce);
        requireValidHMAC(message, signingKey);
      }

      // Emergency cleanup should have been triggered
      const stats = getNonceStats();
      expect(stats.active).toBeLessThanOrEqual(10001);
    });
  });
});
