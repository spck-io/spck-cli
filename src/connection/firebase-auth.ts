/**
 * Firebase authentication with local callback server
 * Opens browser for OAuth flow, captures token via localhost POST
 *
 * Security features:
 * - Token sent via POST body (not in URL) to prevent leaking via browser history/referrer
 * - State parameter for CSRF protection
 * - Localhost-only callback server
 */

import * as http from 'http';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import open from 'open';
import qrcode from 'qrcode-terminal';
import { FirebaseCredentials, StoredCredentials } from '../types.js';
import { saveCredentials } from '../config/credentials.js';
import { logAuth } from '../utils/logger.js';
import { t } from '../i18n/index.js';

const AUTH_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const FIREBASE_AUTH_BASE_URL = 'https://spck.io/auth';
const FIREBASE_API_BASE_URL = 'https://spck.io/api/auth';

// Module-level references to allow aborting auth from outside (e.g., SIGINT handler)
let _authAbortController: AbortController | null = null;
let _authCallbackServer: http.Server | null = null;

/**
 * Abort any in-progress authentication (e.g., on SIGINT).
 * Cancels the pending fetch and closes the local callback server.
 */
export function abortCurrentAuth(): void {
  _authAbortController?.abort();
  _authCallbackServer?.close();
  _authAbortController = null;
  _authCallbackServer = null;
}

/**
 * Find an available port for the local callback server
 */
async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'string' ? 0 : address?.port || 0;

      server.close(() => {
        resolve(port);
      });
    });

    server.on('error', reject);
  });
}

interface TokenResult {
  token: string;
  refreshToken: string;
}

/**
 * Poll server API for token (manual flow)
 */
async function pollServerForToken(code: string, signal: AbortSignal): Promise<TokenResult | null> {
  const pollInterval = 3000; // Poll every 3 seconds

  while (!signal.aborted) {
    try {
      const response = await fetch(`${FIREBASE_API_BASE_URL}/token?code=${code}`, {
        signal
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const result = await response.json();

      if (result.token && result.refreshToken) {
        return { token: result.token, refreshToken: result.refreshToken };
      } else if (result.error === 'expired') {
        throw new Error('Authentication code expired');
      }

      // Still pending, wait and retry
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return null; // Polling cancelled
      }
      // Continue polling on network errors
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  return null;
}

/**
 * Parse POST body from request
 */
function parsePostBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        // Try JSON first
        if (req.headers['content-type']?.includes('application/json')) {
          resolve(JSON.parse(body));
        } else {
          // Parse URL-encoded form data
          const params = new URLSearchParams(body);
          const result: Record<string, string> = {};
          params.forEach((value, key) => { result[key] = value; });
          resolve(result);
        }
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Authenticate with Firebase using secure local callback server
 * Token is received via POST to prevent exposure in URLs
 */
export async function authenticateWithFirebase(): Promise<FirebaseCredentials> {
  console.log('\n=== ' + t('auth.title') + ' ===\n');

  // 1. Start local HTTP server
  const port = await getAvailablePort();
  console.log(t('auth.startingCallback', { port: String(port) }));

  const callbackServer = http.createServer();

  await new Promise<void>(resolve => {
    callbackServer.listen(port, () => resolve());
  });

  const redirectUrl = `http://localhost:${port}/callback`;

  // 2. Generate code for both browser and manual flows
  const code = crypto.randomBytes(32).toString('hex');

  // 3. Build auth URLs
  // Browser flow: localhost callback
  const browserUrl = new URL(FIREBASE_AUTH_BASE_URL);
  browserUrl.searchParams.set('redirect', redirectUrl);
  browserUrl.searchParams.set('state', code);

  // Manual flow: server API caching
  const manualUrl = new URL(FIREBASE_AUTH_BASE_URL);
  manualUrl.searchParams.set('code', code);

  // 4. Open browser (primary method)
  console.log(t('auth.openingBrowser') + '\n');

  try {
    await open(browserUrl.toString());
  } catch (error: any) {
    console.warn('⚠️  ' + t('auth.couldNotOpenBrowser', { message: error.message }) + '\n');
  }

  // 5. Display fallback method
  console.log(t('auth.manualAuthHint') + '\n');

  // Display QR code
  qrcode.generate(manualUrl.toString(), { small: true });

  console.log('\n' + t('auth.visitUrl', { url: manualUrl.toString() }) + '\n');
  console.log(t('auth.waiting') + '\n');

  // 6. Wait for authentication from either source (browser or manual)
  const abortController = new AbortController();
  _authAbortController = abortController;
  _authCallbackServer = callbackServer;

  const result = await new Promise<FirebaseCredentials>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortController.abort();
      callbackServer.close();
      reject(new Error('Authentication timeout after 10 minutes'));
    }, AUTH_TIMEOUT);

    // Start polling server API (manual flow)
    const serverPolling = pollServerForToken(code, abortController.signal).then(token => {
      if (token) {
        abortController.abort();
        callbackServer.close();
        return token;
      }
      return null;
    });

    // Handle localhost callback (browser flow)
    callbackServer.on('request', async (req, res) => {
      // Add CORS headers for POST requests from browser
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Only handle callback path
      if (!req.url || !req.url.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Parse request parameters
      let receivedState: string | null = null;
      let token: string | null = null;
      let refreshToken: string | null = null;
      let error: string | null = null;

      try {
        if (req.method === 'POST') {
          const body = await parsePostBody(req);
          receivedState = body.state || null;
          token = body.token || null;
          refreshToken = body.refreshToken || null;
          error = body.error || null;
        } else {
          const url = new URL(req.url, `http://localhost:${port}`);
          receivedState = url.searchParams.get('state');
          token = url.searchParams.get('token');
          refreshToken = url.searchParams.get('refreshToken');
          error = url.searchParams.get('error');
        }
      } catch (parseError: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Failed to parse request' }));
        reject(new Error(`Failed to parse request: ${parseError.message}`));
        return;
      }

      // Verify state/code (CSRF protection)
      if (receivedState !== code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid state parameter' }));
        reject(new Error('Invalid state parameter'));
        return;
      }

      // Check for error
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error }));
        reject(new Error(error));
        return;
      }

      // Check for token
      if (!token) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No token received' }));
        reject(new Error('No token received'));
        return;
      }

      // Check for refresh token BEFORE decoding
      if (!refreshToken) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No refresh token received' }));
        reject(new Error('No refresh token received'));
        return;
      }

      // Decode and validate token
      let decoded: any;
      try {
        decoded = jwt.decode(token);

        if (!decoded || typeof decoded === 'string') {
          throw new Error('Invalid token format');
        }

        if (!decoded.sub && !decoded.uid) {
          throw new Error('Token missing user ID');
        }

        if (!decoded.exp) {
          throw new Error('Token missing expiry');
        }
      } catch (decodeError: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Invalid token: ${decodeError.message}` }));
        reject(new Error(`Invalid token: ${decodeError.message}`));
        return;
      }

      // All validations passed - send success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

      // Clean up and resolve
      clearTimeout(timeout);
      abortController.abort(); // Stop server polling

      const credentials: FirebaseCredentials = {
        firebaseToken: token,
        firebaseTokenExpiry: decoded.exp * 1000,
        refreshToken,
        userId: decoded.sub || decoded.uid
      };

      resolve(credentials);
    });

    callbackServer.on('error', (error) => {
      clearTimeout(timeout);
      abortController.abort();
      reject(error);
    });

    // Handle server polling result (manual flow)
    serverPolling.then(result => {
      if (!result) return; // Aborted or timed out

      try {
        const { token, refreshToken } = result;

        // Decode token to get userId and expiry
        const decoded: any = jwt.decode(token);

        if (!decoded || typeof decoded === 'string') {
          throw new Error('Invalid token format');
        }

        if (!decoded.sub && !decoded.uid) {
          throw new Error('Token missing user ID');
        }

        if (!decoded.exp) {
          throw new Error('Token missing expiry');
        }

        clearTimeout(timeout);

        const credentials: FirebaseCredentials = {
          firebaseToken: token,
          firebaseTokenExpiry: decoded.exp * 1000,
          refreshToken,
          userId: decoded.sub || decoded.uid
        };

        resolve(credentials);
      } catch (error: any) {
        reject(new Error(`Invalid token from server: ${error.message}`));
      }
    }).catch(error => {
      clearTimeout(timeout);
      abortController.abort();
      callbackServer.close();
      reject(error);
    });
  });

  // 6. Close server and clear module-level references
  callbackServer.close();
  _authAbortController = null;
  _authCallbackServer = null;

  // 7. Save credentials
  saveCredentials(result);

  logAuth('firebase_auth_success', {
    userId: result.userId,
    method: 'firebase'
  });

  console.log('✅ ' + t('auth.success'));
  console.log('   ' + t('auth.userId', { userId: result.userId }) + '\n');

  return result;
}

// Firebase API key for token refresh
const FIREBASE_API_KEY = 'AIzaSyCFgtHhWiM-EdFBdiDw9ISHfcGOqbV3OCU';

/**
 * Refresh Firebase ID token using refresh token
 *
 * Firebase Token Refresh Protocol:
 * - Endpoint: https://securetoken.googleapis.com/v1/token?key={API_KEY}
 * - Method: POST with application/x-www-form-urlencoded
 * - Body: grant_type=refresh_token&refresh_token={REFRESH_TOKEN}
 * - Response: { id_token, refresh_token, expires_in, token_type, user_id }
 * - ID tokens expire after 1 hour (3600 seconds)
 * - Refresh tokens are long-lived but can be revoked
 *
 * @see https://firebase.google.com/docs/reference/rest/auth#section-refresh-token
 */
export async function refreshFirebaseToken(storedCredentials: StoredCredentials): Promise<FirebaseCredentials> {
  if (!storedCredentials.refreshToken) {
    console.log('⚠️  ' + t('auth.noRefreshToken'));
    return authenticateWithFirebase();
  }

  try {
    const response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(storedCredentials.refreshToken)}`
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `HTTP ${response.status}`;

      // Handle specific Firebase errors
      if (errorMessage === 'TOKEN_EXPIRED' || errorMessage === 'INVALID_REFRESH_TOKEN') {
        logAuth('token_refresh_failed', {
          userId: storedCredentials.userId,
          reason: errorMessage
        }, 'warn');
        console.log('⚠️  ' + t('auth.refreshTokenExpired'));
        return authenticateWithFirebase();
      }

      throw new Error(`Token refresh failed: ${errorMessage}`);
    }

    const data = await response.json();

    // Firebase returns: id_token, refresh_token, expires_in, token_type, user_id
    const newToken = data.id_token;
    const newRefreshToken = data.refresh_token;
    const parsedExpiresIn = parseInt(data.expires_in, 10);
    const expiresIn = isNaN(parsedExpiresIn) ? 3600 : parsedExpiresIn; // Default 1 hour
    const userId = data.user_id;

    if (!newToken) {
      throw new Error('No ID token in refresh response');
    }

    // Build full credentials with fresh ID token
    const fullCredentials: FirebaseCredentials = {
      firebaseToken: newToken,
      firebaseTokenExpiry: Date.now() + (expiresIn * 1000),
      refreshToken: newRefreshToken || storedCredentials.refreshToken,
      userId: userId || storedCredentials.userId
    };

    // Save only refreshToken + userId to disk (not the ephemeral ID token)
    saveCredentials({
      refreshToken: fullCredentials.refreshToken,
      userId: fullCredentials.userId,
      proxyServerUrl: storedCredentials.proxyServerUrl
    });

    return fullCredentials;
  } catch (error: any) {
    logAuth('token_refresh_error', {
      userId: storedCredentials.userId,
      error: error.message
    }, 'error');
    console.error(t('auth.tokenRefreshError', { message: error.message }));
    console.log('⚠️  ' + t('auth.tokenRefreshFailed'));
    return authenticateWithFirebase();
  }
}

/**
 * Get a valid Firebase ID token by refreshing from stored credentials
 * Always generates a fresh ID token using the refresh token
 */
export async function getValidFirebaseToken(storedCredentials: StoredCredentials): Promise<FirebaseCredentials> {
  console.log('🔄 ' + t('auth.generatingToken'));
  return refreshFirebaseToken(storedCredentials);
}
