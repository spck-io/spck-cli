/**
 * Spck Networking CLI - Proxy Mode Entry Point
 * Connects to proxy server for remote filesystem, git, and terminal access
 */

import { loadConfig, ConfigNotFoundError } from './config/config';
import {
  loadCredentials,
  isTokenExpired,
  loadConnectionSettings,
  isServerTokenExpired,
} from './config/credentials';
import { authenticateWithFirebase, refreshFirebaseToken } from './connection/firebase-auth';
import { runSetup } from './setup/wizard';
import { detectTools, displayFeatureSummary } from './utils/tool-detection';
import { ProxyClient } from './proxy/ProxyClient';
import { RPCRouter } from './rpc/router';
import { ServerConfig, FirebaseCredentials } from './types';

let proxyClient: ProxyClient | null = null;

/**
 * Start the proxy client
 */
export async function startProxyClient(configPath?: string): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('     Spck Networking CLI - Proxy Mode');
  console.log('='.repeat(60) + '\n');

  try {
    // Step 1: Load or create configuration
    let config: ServerConfig;

    try {
      config = loadConfig(configPath);
      console.log('✅ Configuration loaded\n');
    } catch (error: any) {
      if (error instanceof ConfigNotFoundError) {
        // Run setup wizard for missing config
        console.log('No configuration found. Running setup wizard...\n');
        config = await runSetup(configPath);
      } else if (error.code === 'CORRUPTED' || error instanceof SyntaxError) {
        // Config file is corrupted - trigger setup wizard
        console.warn('⚠️  Configuration file is corrupted');
        console.warn('   Running setup wizard to recreate...\n');
        config = await runSetup(configPath);
      } else {
        throw error;
      }
    }

    // Step 2: Authenticate with Firebase
    let credentials: FirebaseCredentials | null = null;

    try {
      credentials = loadCredentials();
    } catch (error: any) {
      if (error.code === 'CORRUPTED') {
        // Credentials file is corrupted - trigger re-authentication
        credentials = null; // Will trigger re-auth below
      } else {
        throw error;
      }
    }

    if (!credentials || isTokenExpired(credentials)) {
      if (credentials) {
        console.log('⚠️  Firebase token expired. Re-authenticating...\n');
      }

      credentials = await authenticateWithFirebase();
    } else {
      console.log('✅ Firebase credentials loaded');
      console.log(`   User ID: ${credentials.userId}\n`);
    }

    // Step 3: Validate root directory
    const fs = await import('fs');
    if (!fs.existsSync(config.root)) {
      console.error(`\n❌ Root directory not found: ${config.root}\n`);
      console.error('Please ensure the directory exists and is accessible, or run setup wizard:');
      console.error('  spck-networking --setup\n');
      process.exit(1);
    }

    // Step 4: Detect tools
    const tools = await detectTools();

    // Step 5: Initialize RPC Router
    console.log('Initializing services...');
    RPCRouter.initialize(config.root, config);
    console.log('✅ Services initialized\n');

    // Step 6: Check connection settings
    let connectionSettings = null;
    let needsReconnect = false;

    try {
      connectionSettings = loadConnectionSettings();
    } catch (error: any) {
      if (error.code === 'CORRUPTED') {
        // Connection settings corrupted - will reconnect with Firebase credentials
        console.warn('⚠️  Connection settings corrupted, will reconnect to proxy...\n');
        connectionSettings = null;
        needsReconnect = true;
      } else {
        throw error;
      }
    }

    if (!connectionSettings) {
      if (!needsReconnect) {
        console.log('No existing connection found. Connecting to proxy...\n');
      }
      needsReconnect = true;
    } else if (isServerTokenExpired(connectionSettings)) {
      console.log('⚠️  Server token expired. Reconnecting...\n');
      needsReconnect = true;
    } else {
      console.log('✅ Existing connection found');
      console.log(`   Connected at: ${new Date(connectionSettings.connectedAt).toLocaleString()}\n`);
    }

    // Step 7: Create and connect ProxyClient
    proxyClient = new ProxyClient({
      config,
      firebaseToken: credentials.firebaseToken,
      userId: credentials.userId,
      tools,
      existingConnectionSettings: needsReconnect ? undefined : connectionSettings,
    });

    await proxyClient.connect();

    // Step 7: Display feature summary
    displayFeatureSummary(tools, config.terminal.enabled);

  } catch (error: any) {
    // Handle specific error cases with helpful messages
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      // Permission error
      console.error('\n❌ Permission Error: Cannot write to required directory\n');
      console.error(`Path: ${error.path || 'unknown'}`);
      console.error(`Operation: ${error.operation || 'file operation'}\n`);
      console.error('Please fix permissions:');
      console.error('  chmod 700 ~/.spck-editor');
      console.error('  chmod 600 ~/.spck-editor/.credentials.json\n');
      console.error('Or ensure your user has write access to the home directory.\n');
      process.exit(1);
    } else if (error.code === 'ENOSPC') {
      // Disk full error
      console.error('\n❌ Disk Full: No space left on device\n');
      console.error(`Path: ${error.path || 'unknown'}`);
      console.error(`Operation: ${error.operation || 'file operation'}\n`);
      console.error('Please free up disk space and try again.\n');
      process.exit(1);
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      // Network/proxy connection error
      console.error('\n❌ Cannot connect to proxy server\n');
      console.error(`Error: ${error.message}\n`);
      console.error('Possible causes:');
      console.error('  - Proxy server is down');
      console.error('  - Network connection issue');
      console.error('  - Incorrect proxy URL in config\n');
      console.error('Please check the proxy URL and try again.\n');
      process.exit(1);
    } else {
      // Generic error
      console.error('\n❌ Failed to start proxy client:', error.message);

      if (error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }

      process.exit(1);
    }
  }
}

/**
 * Setup graceful shutdown
 */
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    console.log(`\n\nReceived ${signal}`);

    if (proxyClient) {
      try {
        await proxyClient.disconnect();
      } catch (error: any) {
        console.error('Error during shutdown:', error.message);
      }
    }

    console.log('Goodbye! 👋\n');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('\n❌ Uncaught exception:', error.message);
    console.error(error.stack);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any) => {
    console.error('\n❌ Unhandled rejection:', reason?.message || reason);
    if (reason?.stack) {
      console.error(reason.stack);
    }
    process.exit(1);
  });
}

// Start client if run directly
if (require.main === module) {
  setupGracefulShutdown();

  startProxyClient().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
