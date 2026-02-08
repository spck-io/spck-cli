/**
 * Spck Networking CLI - Proxy Mode Entry Point
 * Connects to proxy server for remote filesystem, git, and terminal access
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import jwt from 'jsonwebtoken';
import { loadConfig, ConfigNotFoundError } from './config/config.js';
import {
  loadCredentials,
  loadConnectionSettings,
  isServerTokenExpired,
  clearCredentials,
  clearConnectionSettings,
  getCredentialsPath,
  getConnectionSettingsPath,
} from './config/credentials.js';
import { authenticateWithFirebase, getValidFirebaseToken } from './connection/firebase-auth.js';
import { runSetup } from './setup/wizard.js';
import { detectTools, displayFeatureSummary } from './utils/tool-detection.js';
import { ensureProjectDir } from './utils/project-dir.js';
import { ProxyClient } from './proxy/ProxyClient.js';
import { RPCRouter } from './rpc/router.js';
import { ServerConfig, FirebaseCredentials, StoredCredentials } from './types.js';

let proxyClient: ProxyClient | null = null;

/**
 * Start the proxy client
 */
export async function startProxyClient(
  configPath?: string,
  options?: {
    disableGit?: boolean;
    disableRipgrep?: boolean;
  }
): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('     Spck CLI');
  console.log('='.repeat(60) + '\n');

  try {
    // Step 0: Ensure project directory is set up (creates symlink)
    ensureProjectDir(process.cwd());

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
    let storedCredentials: StoredCredentials | null = null;
    let credentials: FirebaseCredentials;

    try {
      storedCredentials = loadCredentials();
    } catch (error: any) {
      if (error.code === 'CORRUPTED') {
        // Credentials file is corrupted - trigger re-authentication
        storedCredentials = null; // Will trigger re-auth below
      } else {
        throw error;
      }
    }

    if (!storedCredentials) {
      // No stored credentials - full authentication required
      credentials = await authenticateWithFirebase();
    } else {
      // Have stored credentials - generate fresh ID token using refresh token
      credentials = await getValidFirebaseToken(storedCredentials);
      console.log('✅ Firebase credentials loaded');
      console.log(`   User ID: ${credentials.userId}\n`);
    }

    // Step 3: Validate root directory
    const fs = await import('fs');
    if (!fs.existsSync(config.root)) {
      console.error(`\n❌ Root directory not found: ${config.root}\n`);
      console.error('Please ensure the directory exists and is accessible, or run setup wizard:');
      console.error('  spck --setup\n');
      process.exit(1);
    }

    // Step 4: Detect tools
    const tools = await detectTools({
      disableGit: options?.disableGit,
      disableRipgrep: options?.disableRipgrep,
    });

    // Step 5: Initialize RPC Router
    RPCRouter.initialize(config.root, config, tools);

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

    // Step 7: Display feature summary
    displayFeatureSummary(tools, config.terminal.enabled, config.security.userAuthenticationEnabled);

    // Step 7: Create and connect ProxyClient
    proxyClient = new ProxyClient({
      config,
      firebaseToken: credentials.firebaseToken,
      userId: credentials.userId,
      tools,
      existingConnectionSettings: needsReconnect ? undefined : connectionSettings,
    });

    await proxyClient.connect();

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
 * Logout - clear credentials and connection settings
 */
export async function logout(): Promise<void> {
  console.log('\n=== Logout ===\n');

  let clearedSomething = false;

  // Clear user credentials
  const credentialsPath = getCredentialsPath();
  if (fs.existsSync(credentialsPath)) {
    clearCredentials();
    console.log('✅ Cleared user credentials');
    console.log(`   Removed: ${credentialsPath}`);
    clearedSomething = true;
  }

  // Clear connection settings
  const settingsPath = getConnectionSettingsPath();
  if (fs.existsSync(settingsPath)) {
    clearConnectionSettings();
    console.log('✅ Cleared connection settings');
    console.log(`   Removed: ${settingsPath}`);
    clearedSomething = true;
  }

  if (!clearedSomething) {
    console.log('ℹ️  No credentials or connection settings found');
    console.log('   You are not currently logged in.\n');
  } else {
    console.log('\n✨ Successfully logged out!\n');
    console.log('Run the CLI again to re-authenticate.\n');
  }

  process.exit(0);
}

/**
 * Show account information - email and subscription status
 */
export async function showAccountInfo(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('     Account Information');
  console.log('='.repeat(60) + '\n');

  try {
    // Load stored credentials
    let storedCredentials: StoredCredentials | null = null;
    try {
      storedCredentials = loadCredentials();
    } catch (error: any) {
      if (error.code === 'CORRUPTED') {
        console.error('❌ Credentials file is corrupted.\n');
        console.error('   Please logout and re-authenticate:');
        console.error('     spck --logout\n');
        process.exit(1);
      }
      throw error;
    }

    if (!storedCredentials) {
      console.log('ℹ️  Not currently logged in.\n');
      console.log('   Run the CLI to authenticate:');
      console.log('     spck\n');
      process.exit(0);
    }

    // Get fresh Firebase token
    console.log('🔄 Fetching account information...\n');
    const credentials = await getValidFirebaseToken(storedCredentials);

    // Decode JWT to extract user information
    const decoded: any = jwt.decode(credentials.firebaseToken);

    if (!decoded) {
      console.error('❌ Failed to decode authentication token\n');
      process.exit(1);
    }

    console.log('✅ Logged In\n');
    console.log(`   User ID:  ${credentials.userId}`);

    // Extract email from JWT claims if available
    if (decoded.email) {
      console.log(`   Email:    ${decoded.email}`);
      if (decoded.email_verified !== undefined) {
        console.log(`   Verified: ${decoded.email_verified ? 'Yes' : 'No'}`);
      }
    }

    // Show token expiry
    if (decoded.exp) {
      const expiryDate = new Date(decoded.exp * 1000);
      const now = new Date();
      const timeLeft = expiryDate.getTime() - now.getTime();
      const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
      const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

      console.log(`\n   Token expires: ${expiryDate.toLocaleString()}`);
      if (timeLeft > 0) {
        console.log(`   Time remaining: ${hoursLeft}h ${minutesLeft}m`);
      }
    }

    // Check for subscription information in JWT claims
    if (decoded.subscription || decoded.premium || decoded.plan) {
      console.log('\n📋 Subscription');
      if (decoded.subscription) {
        console.log(`   Status: ${decoded.subscription}`);
      }
      if (decoded.plan) {
        console.log(`   Plan: ${decoded.plan}`);
      }
      if (decoded.premium !== undefined) {
        console.log(`   Premium: ${decoded.premium ? 'Yes' : 'No'}`);
      }
    }

    console.log('\n' + '='.repeat(60) + '\n');

    process.exit(0);

  } catch (error: any) {
    console.error('\n❌ Failed to retrieve account information\n');
    console.error(`   Error: ${error.message}\n`);

    if (error.code === 'EACCES' || error.code === 'EPERM') {
      console.error('   Permission denied accessing credentials file');
      console.error('   Please check file permissions:\n');
      console.error('     chmod 600 ~/.spck-editor/.credentials.json\n');
    } else if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      console.error('   Network connection error');
      console.error('   Please check your internet connection\n');
    }

    process.exit(1);
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

/**
 * Main CLI entry point - parse arguments and run appropriate command
 */
export async function main(): Promise<void> {
  setupGracefulShutdown();

  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
    .example('$0', 'Start the proxy client with default settings')
    .example('$0 --setup', 'Run the interactive setup wizard')
    .example('$0 --account', 'Show current account email and subscription status')
    .example('$0 --logout', 'Logout and clear all credentials')
    .example('$0 -c /path/to/config.json', 'Use a custom configuration file')
    .option('config', {
      alias: 'c',
      type: 'string',
      description: 'Path to configuration file (default: .spck-editor/config/spck-cli.config.json)',
    })
    .option('setup', {
      type: 'boolean',
      description: 'Run interactive setup wizard',
      default: false,
    })
    .option('account', {
      type: 'boolean',
      description: 'Show account information (email and subscription status)',
      default: false,
    })
    .option('logout', {
      type: 'boolean',
      description: 'Logout and clear all credentials and connection settings',
      default: false,
    })
    .option('port', {
      alias: 'p',
      type: 'number',
      description: 'Server port (overrides config)',
    })
    .option('root', {
      alias: 'r',
      type: 'string',
      description: 'Root directory to serve (overrides config)',
    })
    // Hidden development flags (not documented)
    .option('__internal_disable_ripgrep', {
      type: 'boolean',
      hidden: true,
      default: false,
    })
    .option('__internal_disable_git', {
      type: 'boolean',
      hidden: true,
      default: false,
    })
    .help()
    .alias('help', 'h')
    .version()
    .alias('version', 'v')
    .strict()
    .fail((msg, err, yargs) => {
      if (err) throw err; // Preserve stack trace for actual errors
      console.error('\n❌ Error:', msg);
      console.error('\nRun with --help to see available commands and options.\n');
      process.exit(1);
    })
    .epilogue(
      'For more information, visit: https://github.com/spck-io/spck\n\n' +
      'Configuration:\n' +
      '  User credentials: ~/.spck-editor/.credentials.json\n' +
      '  Project data: ~/.spck-editor/projects/{project_id}/\n' +
      '  Project directory: .spck-editor/ (contains local files and config symlink)\n' +
      '  Config symlink: .spck-editor/config -> ~/.spck-editor/projects/{project_id}/\n\n' +
      'Authentication:\n' +
      '  The CLI uses Firebase authentication to securely connect to the proxy server.\n' +
      '  You will be prompted to authenticate on first run or when credentials expire.\n' +
      '  Use --logout to clear credentials and connection settings.'
    )
    .parseSync();

  // Execute the appropriate command
  if (argv.account) {
    await showAccountInfo();
  } else if (argv.logout) {
    await logout();
  } else if (argv.setup) {
    await runSetup(argv.config as string | undefined);
    process.exit(0);
  } else {
    await startProxyClient(argv.config as string | undefined, {
      disableGit: argv.__internal_disable_git as boolean | undefined,
      disableRipgrep: argv.__internal_disable_ripgrep as boolean | undefined,
    });
  }
}

// Auto-run if executed directly (e.g., via npm start or node dist/index.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: any) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
