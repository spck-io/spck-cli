/**
 * Firebase credentials management
 * Handles user-level credential storage in ~/.spck-editor/.credentials.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as jwt from 'jsonwebtoken';
import { FirebaseCredentials } from '../types';

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
 * Check if Firebase token is expired
 */
export function isTokenExpired(credentials: FirebaseCredentials): boolean {
  // Check expiry timestamp first
  if (credentials.firebaseTokenExpiry && credentials.firebaseTokenExpiry < Date.now()) {
    return true;
  }

  // Also decode JWT to double-check
  try {
    const decoded = jwt.decode(credentials.firebaseToken) as any;
    if (!decoded || !decoded.exp) {
      return true;
    }

    // Add 5-minute buffer for safety
    const expiryWithBuffer = (decoded.exp * 1000) - (5 * 60 * 1000);
    return Date.now() > expiryWithBuffer;
  } catch {
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
