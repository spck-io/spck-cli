/**
 * Firebase credentials management
 * Handles user-level credential storage in ~/.spck-editor/.credentials.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StoredCredentials } from '../types.js';
import { getProjectFilePath } from '../utils/project-dir.js';

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
 * This uses the symlinked project directory
 */
export function getConnectionSettingsPath(): string {
  return getProjectFilePath(process.cwd(), 'connection-settings.json');
}

/**
 * Load stored credentials from user-level storage
 * Returns only refreshToken + userId; firebaseToken is generated on demand
 * @throws {Error} with code 'CORRUPTED' if file is corrupted
 */
export function loadCredentials(): StoredCredentials | null {
  const credentialsPath = getCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(credentialsPath, 'utf8');
    const credentials = JSON.parse(data);

    // Validate required fields for stored credentials
    if (!credentials.refreshToken || !credentials.userId) {
      const error: any = new Error('Invalid credentials format - missing refreshToken or userId');
      error.code = 'CORRUPTED';
      error.path = credentialsPath;
      throw error;
    }

    // Return only the stored fields (refreshToken + userId)
    return {
      refreshToken: credentials.refreshToken,
      userId: credentials.userId
    };
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
 * Save stored credentials to user-level storage
 * Only persists refreshToken + userId (not firebaseToken or expiry)
 * @throws {Error} with code 'EACCES' for permission errors
 * @throws {Error} with code 'ENOSPC' for disk full errors
 */
export function saveCredentials(credentials: StoredCredentials): void {
  const credentialsDir = getCredentialsDir();
  const credentialsPath = getCredentialsPath();

  try {
    // Ensure directory exists
    if (!fs.existsSync(credentialsDir)) {
      fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    }

    // Only persist refreshToken + userId
    const storedData: StoredCredentials = {
      refreshToken: credentials.refreshToken,
      userId: credentials.userId
    };

    // Write credentials file with restricted permissions
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify(storedData, null, 2),
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
    // Ensure directory exists with restricted permissions
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    }

    // Write settings file with restricted permissions (owner read/write only)
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(settings, null, 2),
      { encoding: 'utf8', mode: 0o600 }
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
