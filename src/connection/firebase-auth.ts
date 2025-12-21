/**
 * Firebase authentication with local callback server
 * Opens browser for OAuth flow, captures token via localhost redirect
 */

import * as http from 'http';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import open from 'open';
import { FirebaseCredentials } from '../types.js';
import { saveCredentials } from '../config/credentials.js';

const AUTH_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const FIREBASE_AUTH_BASE_URL = 'https://spck.io/firebase-auth';

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

/**
 * Authenticate with Firebase using local callback server
 */
export async function authenticateWithFirebase(): Promise<FirebaseCredentials> {
  console.log('\n=== Firebase Authentication ===\n');

  // 1. Start local HTTP server
  const port = await getAvailablePort();
  console.log(`Starting local callback server on port ${port}...`);

  const callbackServer = http.createServer();

  await new Promise<void>(resolve => {
    callbackServer.listen(port, () => resolve());
  });

  const redirectUrl = `http://localhost:${port}/callback`;

  // 2. Generate state for CSRF protection
  const state = crypto.randomBytes(32).toString('hex');

  // 3. Build Firebase auth URL
  const authUrl = new URL(FIREBASE_AUTH_BASE_URL);
  authUrl.searchParams.set('redirect', redirectUrl);
  authUrl.searchParams.set('state', state);

  // 4. Open browser
  console.log('Opening browser for authentication...');
  console.log(`If browser doesn't open automatically, visit:`);
  console.log(`  ${authUrl.toString()}\n`);

  try {
    await open(authUrl.toString());
  } catch (error: any) {
    console.warn(`⚠️  Could not open browser automatically: ${error.message}`);
  }

  console.log('Waiting for authentication (timeout: 10 minutes)...\n');

  // 5. Wait for callback
  const result = await new Promise<FirebaseCredentials>((resolve, reject) => {
    const timeout = setTimeout(() => {
      callbackServer.close();
      reject(new Error('Authentication timeout after 10 minutes'));
    }, AUTH_TIMEOUT);

    callbackServer.on('request', async (req, res) => {
      // Only handle callback path
      if (!req.url || !req.url.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        const receivedState = url.searchParams.get('state');
        const token = url.searchParams.get('token');
        const error = url.searchParams.get('error');

        // Verify state (CSRF protection)
        if (receivedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Authentication Failed</title></head>
              <body>
                <h1>❌ Authentication Failed</h1>
                <p>Invalid state parameter (CSRF protection)</p>
                <p>Please close this window and try again.</p>
              </body>
            </html>
          `);
          reject(new Error('Invalid state parameter'));
          return;
        }

        // Check for error
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Authentication Failed</title></head>
              <body>
                <h1>❌ Authentication Failed</h1>
                <p>Error: ${escapeHtml(error)}</p>
                <p>Please close this window and try again.</p>
              </body>
            </html>
          `);
          reject(new Error(error));
          return;
        }

        // Check for token
        if (!token) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Authentication Failed</title></head>
              <body>
                <h1>❌ Authentication Failed</h1>
                <p>No authentication token received</p>
                <p>Please close this window and try again.</p>
              </body>
            </html>
          `);
          reject(new Error('No token received'));
          return;
        }

        // Decode token to get userId and expiry
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
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head><title>Authentication Failed</title></head>
              <body>
                <h1>❌ Authentication Failed</h1>
                <p>Invalid token: ${escapeHtml(decodeError.message)}</p>
                <p>Please close this window and try again.</p>
              </body>
            </html>
          `);
          reject(new Error(`Invalid token: ${decodeError.message}`));
          return;
        }

        // Success!
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <head>
              <title>Authentication Successful</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  height: 100vh;
                  margin: 0;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                }
                .container {
                  text-align: center;
                  padding: 2rem;
                  background: rgba(255, 255, 255, 0.1);
                  border-radius: 1rem;
                  backdrop-filter: blur(10px);
                }
                h1 { margin: 0 0 1rem 0; }
                p { margin: 0.5rem 0; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>✅ Authentication Successful!</h1>
                <p>You can now close this window and return to the terminal.</p>
              </div>
              <script>
                setTimeout(() => {
                  window.close();
                }, 3000);
              </script>
            </body>
          </html>
        `);

        clearTimeout(timeout);

        const credentials: FirebaseCredentials = {
          firebaseToken: token,
          firebaseTokenExpiry: decoded.exp * 1000,
          userId: decoded.sub || decoded.uid
        };

        resolve(credentials);
      } catch (handlerError: any) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <head><title>Server Error</title></head>
            <body>
              <h1>❌ Server Error</h1>
              <p>${escapeHtml(handlerError.message)}</p>
            </body>
          </html>
        `);
        reject(handlerError);
      }
    });

    callbackServer.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  // 6. Close server
  callbackServer.close();

  // 7. Save credentials
  saveCredentials(result);

  console.log('✅ Authentication successful!');
  console.log(`   User ID: ${result.userId}\n`);

  return result;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };

  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Refresh Firebase token (if possible)
 * For now, this requires re-authentication
 */
export async function refreshFirebaseToken(): Promise<FirebaseCredentials> {
  console.log('⚠️  Firebase token expired. Re-authentication required.');
  return authenticateWithFirebase();
}
