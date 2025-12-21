/**
 * Firebase credentials management
 * Handles user-level credential storage in ~/.spck-editor/.credentials.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as jwt from 'jsonwebtoken';
import { FirebaseCredentials } from '../types.js';

/**
 * Get the user-level credentials directory
 */
export function getCredentialsDir(): string {
  return path.join(os.homedir(), '.spck-editor');
}

/**
 * Get the credentials file path
 */
export function getCredentialsPath(): string {
  return path.join(getCredentialsDir(), '.credentials.json');
}

/**
 * Get the connection settings file path (project-level)
 */
export function getConnectionSettingsPath(): string {
  return path.join(process.cwd(), '.spck-editor', 'connection-settings.json');
}

/**
 * Load Firebase credentials from user-level storage
 * @throws {Error} with code 'CORRUPTED' if file is corrupted
 */
export function loadCredentials(): FirebaseCredentials | null {
  const credentialsPath = getCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(credentialsPath, 'utf8');
    const credentials: FirebaseCredentials = JSON.parse(data);

    // Validate structure
    if (!credentials.firebaseToken || !credentials.userId) {
      const error: any = new Error('Invalid credentials format - missing required fields');
      error.code = 'CORRUPTED';
      error.path = credentialsPath;
      throw error;
    }

    return credentials;
  } catch (error: any) {
    // JSON parse error or validation error
    if (error instanceof SyntaxError || error.code === 'CORRUPTED') {
      console.warn('⚠️  Credentials file is corrupted:', credentialsPath);
      console.warn('   Will trigger re-authentication...\n');
      const corruptedError: any = new Error('Credentials file is corrupted');
      corruptedError.code = 'CORRUPTED';
      corruptedError.path = credentialsPath;
      corruptedError.originalError = error;
      throw corruptedError;
    }
    // Other errors (permission, etc.)
    throw error;
  }
}

/**
 * Save Firebase credentials to user-level storage
 * @throws {Error} with code 'EACCES' for permission errors
 * @throws {Error} with code 'ENOSPC' for disk full errors
 */
export function saveCredentials(credentials: FirebaseCredentials): void {
  const credentialsDir = getCredentialsDir();
  const credentialsPath = getCredentialsPath();

  try {
    // Ensure directory exists
    if (!fs.existsSync(credentialsDir)) {
      fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    }

    // Write credentials file with restricted permissions
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify(credentials, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (error: any) {
    // Add context to error
    error.path = error.path || credentialsPath;
    error.operation = 'save credentials';
    throw error;
  }
}

/**
 * Validate Firebase ID token structure and claims
 * @param token - Firebase ID token to validate
 * @param options - Validation options
 * @returns Validation result with decoded token or error
 */
export function validateFirebaseToken(
  token: string,
  options: {
    projectId?: string;
    checkExpiry?: boolean;
    expiryBuffer?: number; // milliseconds
  } = {}
): { valid: boolean; decoded?: any; error?: string } {
  const {
    checkExpiry = true,
    expiryBuffer = 5 * 60 * 1000, // 5 minutes default
  } = options;

  try {
    // Decode token WITHOUT verification (we can't verify signature without Firebase public keys)
    // NOTE: For full security, this should fetch and verify against Firebase's public keys
    // See: https://firebase.google.com/docs/auth/admin/verify-id-tokens
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      return { valid: false, error: 'Invalid token format' };
    }

    const payload = decoded.payload;

    // Validate required claims exist
    if (!payload.sub || !payload.iss || !payload.aud || !payload.exp || !payload.iat) {
      return {
        valid: false,
        error: 'Missing required claims (sub, iss, aud, exp, iat)',
      };
    }

    // Validate issuer format (should be https://securetoken.google.com/<project-id>)
    if (!payload.iss.startsWith('https://securetoken.google.com/')) {
      return {
        valid: false,
        error: `Invalid issuer: ${payload.iss}`,
      };
    }

    // Validate audience matches project ID if provided
    if (options.projectId && payload.aud !== options.projectId) {
      return {
        valid: false,
        error: `Audience mismatch: expected ${options.projectId}, got ${payload.aud}`,
      };
    }

    // Validate issued-at time is in the past
    const now = Math.floor(Date.now() / 1000);
    if (payload.iat > now) {
      return {
        valid: false,
        error: 'Token issued in the future',
      };
    }

    // Validate auth_time is in the past
    if (payload.auth_time && payload.auth_time > now) {
      return {
        valid: false,
        error: 'Auth time is in the future',
      };
    }

    // Check expiry if requested
    if (checkExpiry) {
      const expiryWithBuffer = payload.exp - Math.floor(expiryBuffer / 1000);
      if (now > expiryWithBuffer) {
        return {
          valid: false,
          error: `Token expired at ${new Date(payload.exp * 1000).toISOString()}`,
        };
      }
    }

    // NOTE: This function does NOT verify signatures - it's for client-side pre-flight checks only.
    // Full signature verification is handled by auth.ts:verifyFirebaseToken() which:
    // - Fetches Firebase public keys from Google
    // - Verifies RS256 signatures using jsonwebtoken
    // - Handles key rotation via kid
    // - Acts as the production security boundary
    //
    // This function is just an optimization to:
    // - Avoid sending obviously invalid tokens over the network
    // - Provide early validation feedback
    // - Check token structure and basic claims

    return {
      valid: true,
      decoded: payload,
    };
  } catch (error: any) {
    return {
      valid: false,
      error: `Token validation error: ${error.message}`,
    };
  }
}

/**
 * Check if Firebase token is expired
 * Enhanced with comprehensive validation
 */
export function isTokenExpired(credentials: FirebaseCredentials): boolean {
  // Primary check: Use expiry timestamp if available
  if (credentials.firebaseTokenExpiry) {
    const isExpiredByTimestamp = credentials.firebaseTokenExpiry < Date.now();
    if (isExpiredByTimestamp) {
      return true; // Definitely expired
    }
    // If timestamp says not expired, still do comprehensive validation
    // but only if token looks like a valid JWT
    if (!credentials.firebaseToken || typeof credentials.firebaseToken !== 'string') {
      return true;
    }
    // Check if token looks like a JWT (has 3 parts separated by dots)
    if (credentials.firebaseToken.split('.').length !== 3) {
      // Not a JWT format, rely on timestamp only
      return false;
    }
  }

  // Secondary check: Validate token structure and claims
  // This catches cases where timestamp is missing or token is malformed
  try {
    const validation = validateFirebaseToken(credentials.firebaseToken, {
      checkExpiry: true,
      expiryBuffer: 5 * 60 * 1000, // 5-minute safety buffer
    });
    return !validation.valid;
  } catch {
    // If validation throws, assume expired for safety
    return true;
  }
}

/**
 * Clear credentials (logout)
 */
export function clearCredentials(): void {
  const credentialsPath = getCredentialsPath();

  if (fs.existsSync(credentialsPath)) {
    fs.unlinkSync(credentialsPath);
  }
}

/**
 * Load connection settings from project-level storage
 * @throws {Error} with code 'CORRUPTED' if file is corrupted
 */
export function loadConnectionSettings(): any | null {
  const settingsPath = getConnectionSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(data);

    // Validate basic structure
    if (!settings.serverToken || !settings.clientId || !settings.secret) {
      const error: any = new Error('Invalid connection settings format - missing required fields');
      error.code = 'CORRUPTED';
      error.path = settingsPath;
      throw error;
    }

    return settings;
  } catch (error: any) {
    // JSON parse error or validation error
    if (error instanceof SyntaxError || error.code === 'CORRUPTED') {
      console.warn('⚠️  Connection settings file is corrupted:', settingsPath);
      console.warn('   Will reconnect to proxy...\n');
      const corruptedError: any = new Error('Connection settings file is corrupted');
      corruptedError.code = 'CORRUPTED';
      corruptedError.path = settingsPath;
      corruptedError.originalError = error;
      throw corruptedError;
    }
    // Other errors (permission, etc.)
    throw error;
  }
}

/**
 * Save connection settings to project-level storage
 * @throws {Error} with code 'EACCES' for permission errors
 * @throws {Error} with code 'ENOSPC' for disk full errors
 */
export function saveConnectionSettings(settings: any): void {
  const settingsDir = path.dirname(getConnectionSettingsPath());
  const settingsPath = getConnectionSettingsPath();

  try {
    // Ensure directory exists
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    // Write settings file
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(settings, null, 2),
      'utf8'
    );
  } catch (error: any) {
    // Add context to error
    error.path = error.path || settingsPath;
    error.operation = 'save connection settings';
    throw error;
  }
}

/**
 * Clear connection settings
 */
export function clearConnectionSettings(): void {
  const settingsPath = getConnectionSettingsPath();

  if (fs.existsSync(settingsPath)) {
    fs.unlinkSync(settingsPath);
  }
}

/**
 * Check if server JWT is expired
 */
export function isServerTokenExpired(settings: any): boolean {
  if (!settings || !settings.serverTokenExpiry) {
    return true;
  }

  // Add 5-minute buffer for safety
  const expiryWithBuffer = settings.serverTokenExpiry - (5 * 60 * 1000);
  return Date.now() > expiryWithBuffer;
}
