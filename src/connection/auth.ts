/**
 * Firebase JWT authentication with public key verification
 */

import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { JWTPayload, ErrorCode, createRPCError } from '../types.js';

const FIREBASE_KEYS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

interface PublicKeysCache {
  keys: { [kid: string]: string };
  expiresAt: number;
}

let publicKeysCache: PublicKeysCache | null = null;

/**
 * Fetch Firebase public keys with caching
 */
async function getFirebasePublicKeys(): Promise<{ [kid: string]: string }> {
  const now = Date.now();

  // Return cached keys if still valid
  if (publicKeysCache && publicKeysCache.expiresAt > now) {
    return publicKeysCache.keys;
  }

  // Fetch new keys
  const response = await fetch(FIREBASE_KEYS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Firebase public keys: ${response.statusText}`);
  }

  const keys = await response.json() as { [kid: string]: string };

  // Parse cache-control header for expiration
  const cacheControl = response.headers.get('cache-control');
  let maxAge = 3600; // Default: 1 hour

  if (cacheControl) {
    const match = cacheControl.match(/max-age=(\d+)/);
    if (match) {
      maxAge = parseInt(match[1], 10);
    }
  }

  // Cache the keys
  publicKeysCache = {
    keys,
    expiresAt: now + maxAge * 1000,
  };

  return keys;
}

/**
 * Verify Firebase JWT token
 */
export async function verifyFirebaseToken(
  token: string,
  firebaseProjectId: string,
  allowedUids: string[]
): Promise<JWTPayload> {
  try {
    // Fetch public keys
    const publicKeys = await getFirebasePublicKeys();

    // Decode token header to get kid
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      throw createRPCError(
        ErrorCode.AUTHENTICATION_FAILED,
        'Invalid token format'
      );
    }

    const kid = decoded.header.kid;
    if (!kid || !publicKeys[kid]) {
      throw createRPCError(
        ErrorCode.AUTHENTICATION_FAILED,
        'Invalid token key ID'
      );
    }

    // Verify token signature and claims
    const publicKey = publicKeys[kid];
    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      audience: firebaseProjectId,
      issuer: `https://securetoken.google.com/${firebaseProjectId}`,
    }) as JWTPayload;

    // Validate UID is in allowed list
    if (!allowedUids.includes(payload.sub)) {
      throw createRPCError(
        ErrorCode.UID_NOT_AUTHORIZED,
        `UID not authorized: ${payload.sub}`,
        { uid: payload.uid }
      );
    }

    return payload;
  } catch (error: any) {
    // Handle JWT errors
    if (error.name === 'TokenExpiredError') {
      throw createRPCError(
        ErrorCode.JWT_EXPIRED,
        'JWT token expired',
        { expiredAt: error.expiredAt }
      );
    }

    if (error.name === 'JsonWebTokenError') {
      throw createRPCError(
        ErrorCode.AUTHENTICATION_FAILED,
        `JWT verification failed: ${error.message}`
      );
    }

    // Re-throw if already an RPC error
    if (error.code && error.message) {
      throw error;
    }

    // Generic error
    throw createRPCError(
      ErrorCode.AUTHENTICATION_FAILED,
      `Authentication failed: ${error.message || 'Unknown error'}`
    );
  }
}

/**
 * Clear public keys cache (for testing)
 */
export function clearPublicKeysCache(): void {
  publicKeysCache = null;
}
