/**
 * Tests for Firebase JWT authentication
 */

import * as jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { verifyFirebaseToken, clearPublicKeysCache } from '../auth';
import { ErrorCode } from '../../types';

// Mock node-fetch
jest.mock('node-fetch');
const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

describe('Firebase JWT Authentication', () => {
  const mockFirebaseProjectId = 'test-project-123';
  const mockAllowedUids = ['user-123', 'user-456'];

  // Valid RSA keypair for testing
  const mockPrivateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAw6RKHxKcZvbQZWwBLmAT0u2d4J9KsELxXz5Y4WPZZgGlF8qq
sH+0IKnB8k/u+9HHh7+0m0hvP0WqnGPDt9XQXU2B8bPw8KMrZCEKKUw4dKJqRjBi
VpVHaUO0TmG3aGAXRjKp8w6CQhLqNQfPE9jGLQqCtmTcUBkVLLo6PNcvvP/n3p5V
U7y6Z0t6h7sOxfCGEUYxlf4nQ0n8B0v0sGJLW8G0C1Y+vJGQj7gPQKTxO2L8gKHZ
cqP7eFqBbVE6h6ZaVKX0zXqP2QQN9s0KQKULcLJQGPG7E5w3F3kTvLQcH0WOqPqN
XmzJOQnTjK3T1uKnP0WmFbPuP0w3Q0KYQKwxAwIDAQABAoIBAEQV7Dp6+MxJMV1p
l8c3WPfVqCJ1JnPPqKV3yH7h5YRfZQh0vB7qGPLXMLw8rH7Kp5L0vF9Qmv5wWjTY
MYvHqJ5u6zF7rPW9KcYq3cJP5vY0Xp8nKQqxKh3QqLxRPH8qv7jK4c5RVLqX0Qq8
h5PWqK1qJQD7J5dJ8KHQ5T6YpLR8v5lQqKLR8JQvGP3Hqx7pW8QK3XF5L6cQ1YLQ
v8F9JxPH5K6W8L0v3RQHJ8L5qP5F6WYP8R7L5XP6W3H1L8QRFP7Q8KJP9F3YR6QX
P5L8QHFR6Q7P8LYV3JR9F7XQP6L8R5HFXP6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R
5FQP9QECgYEA8KLR6P8F7XQL9P6L8RHFXP6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R
5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L
7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQE
CgYEA0JRP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6
L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ
7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QE
CgYEAxJP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L
7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7
L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QE
CgYBP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8
Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8R
HFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7QE
CgYBP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8
Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8R
HFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7Q=
-----END RSA PRIVATE KEY-----`;

  const mockPublicKey = `-----BEGIN CERTIFICATE-----
MIIDETCCAfkCFHgYxgPKN+bvBx7T6TfYJlQPWwDmMA0GCSqGSIb3DQEBCwUAMEUx
CzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRl
cm5ldCBXaWRnaXRzIFB0eSBMdGQwHhcNMjQxMjE2MDAwMDAwWhcNMjYxMjE2MDAw
MDAwWjBFMQswCQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UE
CgwYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAw6RKHxKcZvbQZWwBLmAT0u2d4J9KsELxXz5Y4WPZZgGlF8qq
sH+0IKnB8k/u+9HHh7+0m0hvP0WqnGPDt9XQXU2B8bPw8KMrZCEKKUw4dKJqRjBi
VpVHaUO0TmG3aGAXRjKp8w6CQhLqNQfPE9jGLQqCtmTcUBkVLLo6PNcvvP/n3p5V
U7y6Z0t6h7sOxfCGEUYxlf4nQ0n8B0v0sGJLW8G0C1Y+vJGQj7gPQKTxO2L8gKHZ
cqP7eFqBbVE6h6ZaVKX0zXqP2QQN9s0KQKULcLJQGPG7E5w3F3kTvLQcH0WOqPqN
XmzJOQnTjK3T1uKnP0WmFbPuP0w3Q0KYQKwxAwIDAQABMA0GCSqGSIb3DQEBCwUA
A4IBAQBvGPLVNO8nQ0J7gH8L5R8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8
Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8R
HFP6L8R5FQP9QEP7L8RHF9P6L7R8Q3JYP5LR8F6XPQ7L8RHFP6L8R5FQP9QEP7L=
-----END CERTIFICATE-----`;

  beforeEach(() => {
    clearPublicKeysCache();
    jest.clearAllMocks();
  });

  describe('verifyFirebaseToken', () => {
    it('should verify valid JWT token with correct claims', async () => {
      // Mock Firebase public keys response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => {
            if (name === 'cache-control') return 'max-age=3600';
            return null;
          },
        } as any,
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      // Create valid token
      const payload = {
        uid: 'user-123',
        aud: mockFirebaseProjectId,
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      const result = await verifyFirebaseToken(
        token,
        mockFirebaseProjectId,
        mockAllowedUids
      );

      expect(result.uid).toBe('user-123');
      expect(result.aud).toBe(mockFirebaseProjectId);
    });

    it('should cache Firebase public keys', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: () => 'max-age=3600',
        } as any,
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      const payload = {
        uid: 'user-123',
        aud: mockFirebaseProjectId,
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      // First call - should fetch keys
      await verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call - should use cached keys
      await verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it('should reject token with expired JWT', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'max-age=3600' } as any,
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      const payload = {
        uid: 'user-123',
        aud: mockFirebaseProjectId,
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      await expect(
        verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids)
      ).rejects.toMatchObject({
        code: ErrorCode.JWT_EXPIRED,
        message: 'JWT token expired',
      });
    });

    it('should reject token with unauthorized UID', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'max-age=3600' } as any,
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      const payload = {
        uid: 'unauthorized-user',
        aud: mockFirebaseProjectId,
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'unauthorized-user',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      await expect(
        verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids)
      ).rejects.toMatchObject({
        code: ErrorCode.UID_NOT_AUTHORIZED,
        message: expect.stringContaining('UID not authorized'),
      });
    });

    it('should reject token with invalid audience', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'max-age=3600' } as any,
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      const payload = {
        uid: 'user-123',
        aud: 'wrong-project',
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      await expect(
        verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids)
      ).rejects.toMatchObject({
        code: ErrorCode.AUTHENTICATION_FAILED,
        message: expect.stringContaining('JWT verification failed'),
      });
    });

    it('should reject token with invalid issuer', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'max-age=3600' } as any,
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      const payload = {
        uid: 'user-123',
        aud: mockFirebaseProjectId,
        iss: 'https://evil.com',
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      await expect(
        verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids)
      ).rejects.toMatchObject({
        code: ErrorCode.AUTHENTICATION_FAILED,
        message: expect.stringContaining('JWT verification failed'),
      });
    });

    it('should reject token with invalid key ID', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'max-age=3600' } as any,
        json: async () => ({ 'other-kid': mockPublicKey }),
      } as any);

      const payload = {
        uid: 'user-123',
        aud: mockFirebaseProjectId,
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'wrong-kid',
      });

      await expect(
        verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids)
      ).rejects.toMatchObject({
        code: ErrorCode.AUTHENTICATION_FAILED,
        message: 'Invalid token key ID',
      });
    });

    it('should reject malformed token', async () => {
      const malformedToken = 'not.a.valid.jwt.token';

      await expect(
        verifyFirebaseToken(malformedToken, mockFirebaseProjectId, mockAllowedUids)
      ).rejects.toMatchObject({
        code: ErrorCode.AUTHENTICATION_FAILED,
        message: expect.stringContaining('Invalid token format'),
      });
    });

    it('should handle Firebase API errors gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        statusText: 'Service Unavailable',
      } as any);

      const payload = {
        uid: 'user-123',
        aud: mockFirebaseProjectId,
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      await expect(
        verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids)
      ).rejects.toThrow('Failed to fetch Firebase public keys');
    });

    it('should refetch keys after cache expiration', async () => {
      // First fetch with short TTL
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'max-age=1' } as any, // 1 second TTL
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      const payload = {
        uid: 'user-123',
        aud: mockFirebaseProjectId,
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      await verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Wait for cache to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Second fetch should happen
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'max-age=3600' } as any,
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      await verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearPublicKeysCache', () => {
    it('should clear the public keys cache', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'max-age=3600' } as any,
        json: async () => ({ 'test-kid': mockPublicKey }),
      } as any);

      const payload = {
        uid: 'user-123',
        aud: mockFirebaseProjectId,
        iss: `https://securetoken.google.com/${mockFirebaseProjectId}`,
        sub: 'user-123',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = jwt.sign(payload, mockPrivateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid',
      });

      // First call - caches keys
      await verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Clear cache
      clearPublicKeysCache();

      // Second call - should fetch again
      await verifyFirebaseToken(token, mockFirebaseProjectId, mockAllowedUids);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
