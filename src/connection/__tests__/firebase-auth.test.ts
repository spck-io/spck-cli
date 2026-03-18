import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
/**
 * Tests for Firebase auth token refresh logic
 */

import { StoredCredentials } from '../../types.js';

// Mock all external dependencies before importing the module
vi.mock('open', () => ({ default: vi.fn() }));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));
vi.mock('jsonwebtoken', () => ({ default: { decode: vi.fn() } }));
vi.mock('../../config/credentials.js', () => ({
  saveCredentials: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
  logAuth: vi.fn(),
}));
vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

// Import after mocks are set up
import { refreshFirebaseToken } from '../firebase-auth.js';

describe('refreshFirebaseToken()', () => {
  const mockStoredCredentials: StoredCredentials = {
    refreshToken: 'mock-refresh-token',
    userId: 'user-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use expires_in value of 0 without falling back to default', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    // Firebase returns expires_in: "0"
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        id_token: 'new-id-token',
        refresh_token: 'new-refresh-token',
        expires_in: '0',
        user_id: 'user-123',
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await refreshFirebaseToken(mockStoredCredentials);

    // With the bug (|| 3600), this would be now + 3600000
    // With the fix (isNaN check), expires_in=0 means token expires immediately
    expect(result.firebaseTokenExpiry).toBe(now);
  });

  it('should use the actual expires_in from the response', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        id_token: 'new-id-token',
        refresh_token: 'new-refresh-token',
        expires_in: '7200',
        user_id: 'user-123',
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await refreshFirebaseToken(mockStoredCredentials);

    expect(result.firebaseTokenExpiry).toBe(now + 7200 * 1000);
  });

  it('should default to 3600 when expires_in is missing', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        id_token: 'new-id-token',
        refresh_token: 'new-refresh-token',
        user_id: 'user-123',
        // expires_in is missing
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await refreshFirebaseToken(mockStoredCredentials);

    expect(result.firebaseTokenExpiry).toBe(now + 3600 * 1000);
  });

  it('should default to 3600 when expires_in is non-numeric', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        id_token: 'new-id-token',
        refresh_token: 'new-refresh-token',
        expires_in: 'invalid',
        user_id: 'user-123',
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await refreshFirebaseToken(mockStoredCredentials);

    expect(result.firebaseTokenExpiry).toBe(now + 3600 * 1000);
  });
});
