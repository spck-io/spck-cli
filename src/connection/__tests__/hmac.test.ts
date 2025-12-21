/**
 * Tests for HMAC message signing validation
 */

import * as crypto from 'crypto';
import { validateHMAC, requireValidHMAC } from '../hmac.js';
import { JSONRPCRequest, ErrorCode } from '../../types.js';

describe('HMAC Validation', () => {
  const signingKey = 'test-signing-key-12345';

  function createSignedMessage(
    method: string,
    params: any,
    timestamp?: number,
    customHmac?: string
  ): JSONRPCRequest {
    const ts = timestamp || Date.now();

    const payload = {
      jsonrpc: '2.0' as const,
      method,
      params,
      id: 1,
    };

    const messageToSign = ts + JSON.stringify(payload);
    const hmac =
      customHmac ||
      crypto.createHmac('sha256', signingKey).update(messageToSign).digest('hex');

    return {
      ...payload,
      timestamp: ts,
      hmac,
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
      const message: JSONRPCRequest = {
        jsonrpc: '2.0',
        method: 'fs.readFile',
        params: { path: '/test.txt' },
        id: 1,
        timestamp: Date.now(),
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
      };

      const isValid = validateHMAC(message, signingKey);

      expect(isValid).toBe(false);
    });

    it('should reject message signed with wrong key', () => {
      const wrongKey = 'different-signing-key';
      const payload = {
        jsonrpc: '2.0' as const,
        method: 'fs.readFile',
        params: { path: '/test.txt' },
        id: 1,
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
      const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, sixMinutesAgo);

      expect(() => requireValidHMAC(message, signingKey)).toThrow(
        expect.objectContaining({
          code: ErrorCode.HMAC_VALIDATION_FAILED,
          message: expect.stringContaining('timestamp too old'),
        })
      );
    });

    it('should accept message within 5 minute window', () => {
      const fourMinutesAgo = Date.now() - 4 * 60 * 1000;
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, fourMinutesAgo);

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
      const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
      const message = createSignedMessage('fs.readFile', { path: '/test.txt' }, sixMinutesAgo);

      try {
        requireValidHMAC(message, signingKey);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.data).toMatchObject({
          timestamp: sixMinutesAgo,
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
});
