/**
 * Spck Networking CLI - Proxy Mode Entry Point
 * Connects to proxy server for remote filesystem, git, and terminal access
 */

import * as fs from 'fs';
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
  loadServerPreference,
  saveServerPreference,
} from './config/credentials.js';
import { fetchServerList, selectBestServer, displayServerPings, getDefaultServerList } from './config/server-selection.js';
import { authenticateWithFirebase, getValidFirebaseToken } from './connection/firebase-auth.js';
import { runSetup } from './setup/wizard.js';
import { detectTools, displayFeatureSummary } from './utils/tool-detection.js';
import { ensureProjectDir } from './utils/project-dir.js';
import { ProxyClient } from './proxy/ProxyClient.js';
import { RPCRouter } from './rpc/router.js';
import { ServerConfig, FirebaseCredentials, StoredCredentials } from './types.js';
import { t, detectLocale, setLocale } from './i18n/index.js';

let proxyClient: ProxyClient | null = null;

/**
 * Start the proxy client
 */
export async function startProxyClient(
  configPath?: string,
  options?: {
    disableGit?: boolean;
    disableRipgrep?: boolean;
    serverOverride?: string;
  }
): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('     ' + t('app.title'));
  console.log('='.repeat(60) + '\n');

  try {
    // Step 0: Ensure project directory is set up (creates symlink)
    ensureProjectDir(process.cwd());

    // Step 1: Load or create configuration
    let config: ServerConfig;

    try {
      config = loadConfig(configPath);
      console.log('✅ ' + t('config.loaded') + '\n');
    } catch (error: any) {
      if (error instanceof ConfigNotFoundError) {
        // Run setup wizard for missing config
        console.log(t('config.notFound') + '\n');
        config = await runSetup(configPath);
      } else if (error.code === 'CORRUPTED' || error instanceof SyntaxError) {
        // Config file is corrupted - trigger setup wizard
        console.warn('⚠️  ' + t('config.corrupted'));
        console.warn('   ' + t('config.corruptedRunSetup') + '\n');
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
      console.log('✅ ' + t('auth.credentialsLoaded'));
      console.log(`   ${t('auth.userId', { userId: credentials.userId })}\n`);
    }

    // Step 3: Validate root directory
    const fs = await import('fs');
    if (!fs.existsSync(config.root)) {
      console.error(`\n❌ ${t('errors.rootNotFound', { path: config.root })}\n`);
      console.error(t('errors.rootNotFoundHint'));
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
        console.warn('⚠️  ' + t('connection.settingsCorrupted') + '\n');
        connectionSettings = null;
        needsReconnect = true;
      } else {
        throw error;
      }
    }

    if (!connectionSettings) {
      if (!needsReconnect) {
        console.log(t('connection.noExisting') + '\n');
      }
      needsReconnect = true;
    } else if (isServerTokenExpired(connectionSettings)) {
      console.log('⚠️  ' + t('connection.tokenExpired') + '\n');
      needsReconnect = true;
    } else {
      console.log('✅ ' + t('connection.existingFound'));
      console.log(`   ${t('connection.connectedAt', { date: new Date(connectionSettings.connectedAt).toLocaleString() })}\n`);
    }

    // Step 7: Display feature summary
    displayFeatureSummary(tools, config.terminal.enabled, config.security.userAuthenticationEnabled);

    // Step 8: Select relay server
    let proxyServerUrl: string;

    if (options?.serverOverride) {
      // CLI --server flag overrides everything
      proxyServerUrl = options.serverOverride;
      saveServerPreference(proxyServerUrl);
      console.log(`✅ ${t('server.usingOverride', { url: proxyServerUrl })}\n`);
    } else {
      // Check saved preference
      const savedServer = loadServerPreference();
      if (savedServer) {
        proxyServerUrl = savedServer;
        console.log(`✅ ${t('server.usingSaved', { url: proxyServerUrl })}\n`);
      } else {
        // Auto-select best server by ping
        try {
          console.log('🌐 ' + t('server.selectingBest'));
          const servers = await fetchServerList();
          await displayServerPings(servers);
          const best = await selectBestServer(servers);
          if (best.ping !== Infinity) {
            proxyServerUrl = best.server.url;
            saveServerPreference(proxyServerUrl);
            const label = best.server.label.en || best.server.url;
            console.log(`✅ ${t('server.selected', { label, url: proxyServerUrl, ping: best.ping })}\n`);
          } else {
            // All servers unreachable — use first server from hardcoded list
            proxyServerUrl = getDefaultServerList()[0].url;
            console.warn(`⚠️  ${t('server.allUnreachable', { url: proxyServerUrl })}\n`);
          }
        } catch (error: any) {
          // Fetch/ping failed — use first server from hardcoded list
          proxyServerUrl = getDefaultServerList()[0].url;
          console.warn(`⚠️  ${t('server.failedSelect', { message: error.message })}`);
          console.warn(`   ${t('server.usingDefault', { url: proxyServerUrl })}\n`);
        }
      }
    }

    // Step 9: Create and connect ProxyClient
    proxyClient = new ProxyClient({
      config,
      firebaseToken: credentials.firebaseToken,
      userId: credentials.userId,
      tools,
      existingConnectionSettings: connectionSettings || undefined,
      proxyServerUrl,
    });

    await proxyClient.connect();

  } catch (error: any) {
    // Handle specific error cases with helpful messages
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      // Permission error
      console.error('\n❌ ' + t('errors.permissionError') + '\n');
      console.error(`${t('errors.permissionPath', { path: error.path || 'unknown' })}`);
      console.error(`${t('errors.permissionOperation', { operation: error.operation || 'file operation' })}\n`);
      console.error(t('errors.permissionFix'));
      console.error('  ' + t('errors.permissionFixCmd1'));
      console.error('  ' + t('errors.permissionFixCmd2') + '\n');
      console.error(t('errors.permissionFixHint') + '\n');
      process.exit(1);
    } else if (error.code === 'ENOSPC') {
      // Disk full error
      console.error('\n❌ ' + t('errors.diskFull') + '\n');
      console.error(`${t('errors.permissionPath', { path: error.path || 'unknown' })}`);
      console.error(`${t('errors.permissionOperation', { operation: error.operation || 'file operation' })}\n`);
      console.error(t('errors.diskFullHint') + '\n');
      process.exit(1);
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      // Network/proxy connection error
      console.error('\n❌ ' + t('errors.cannotConnect') + '\n');
      console.error(`${t('errors.cannotConnectError', { message: error.message })}\n`);
      console.error(t('errors.cannotConnectCauses'));
      console.error('  ' + t('errors.cannotConnectCause1'));
      console.error('  ' + t('errors.cannotConnectCause2'));
      console.error('  ' + t('errors.cannotConnectCause3') + '\n');
      console.error(t('errors.cannotConnectHint') + '\n');
      process.exit(1);
    } else {
      // Generic error
      console.error('\n❌ ' + t('errors.failedToStart', { message: error.message }));

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
  console.log('\n=== ' + t('logout.title') + ' ===\n');

  let clearedSomething = false;

  // Clear user credentials
  const credentialsPath = getCredentialsPath();
  if (fs.existsSync(credentialsPath)) {
    clearCredentials();
    console.log('✅ ' + t('logout.clearedCredentials'));
    console.log(`   ${t('logout.removed', { path: credentialsPath })}`);
    clearedSomething = true;
  }

  // Clear connection settings
  const settingsPath = getConnectionSettingsPath();
  if (fs.existsSync(settingsPath)) {
    clearConnectionSettings();
    console.log('✅ ' + t('logout.clearedSettings'));
    console.log(`   ${t('logout.removed', { path: settingsPath })}`);
    clearedSomething = true;
  }

  if (!clearedSomething) {
    console.log('ℹ️  ' + t('logout.noCredentials'));
    console.log('   ' + t('logout.notLoggedIn') + '\n');
  } else {
    console.log('\n✨ ' + t('logout.success') + '\n');
    console.log(t('logout.runAgain') + '\n');
  }

  process.exit(0);
}

/**
 * Show account information - email and subscription status
 */
export async function showAccountInfo(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('     ' + t('account.title'));
  console.log('='.repeat(60) + '\n');

  try {
    // Load stored credentials
    let storedCredentials: StoredCredentials | null = null;
    try {
      storedCredentials = loadCredentials();
    } catch (error: any) {
      if (error.code === 'CORRUPTED') {
        console.error('❌ ' + t('account.credentialsCorrupted'));
        console.error('   ' + t('account.credentialsCorruptedHint1'));
        console.error('     ' + t('account.credentialsCorruptedHint2') + '\n');
        process.exit(1);
      }
      throw error;
    }

    if (!storedCredentials) {
      console.log('ℹ️  ' + t('account.notLoggedIn'));
      console.log('   ' + t('account.notLoggedInHint1'));
      console.log('     ' + t('account.notLoggedInHint2') + '\n');
      process.exit(0);
    }

    // Get fresh Firebase token
    console.log('🔄 ' + t('account.fetching') + '\n');
    const credentials = await getValidFirebaseToken(storedCredentials);

    // Decode JWT to extract user information
    const decoded: any = jwt.decode(credentials.firebaseToken);

    if (!decoded) {
      console.error('❌ ' + t('account.decodeFailed') + '\n');
      process.exit(1);
    }

    console.log('✅ ' + t('account.loggedIn') + '\n');
    console.log(`   ${t('account.userId', { userId: credentials.userId })}`);

    // Extract email from JWT claims if available
    if (decoded.email) {
      console.log(`   ${t('account.email', { email: decoded.email })}`);
      if (decoded.email_verified !== undefined) {
        console.log(`   ${t('account.verified', { status: decoded.email_verified ? t('account.yes') : t('account.no') })}`);
      }
    }

    // Show token expiry
    if (decoded.exp) {
      const expiryDate = new Date(decoded.exp * 1000);
      const now = new Date();
      const timeLeft = expiryDate.getTime() - now.getTime();
      const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
      const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

      console.log(`\n   ${t('account.tokenExpires', { date: expiryDate.toLocaleString() })}`);
      if (timeLeft > 0) {
        console.log(`   ${t('account.timeRemaining', { hours: hoursLeft, minutes: minutesLeft })}`);
      }
    }

    // Check for subscription information in JWT claims
    if (decoded.subscription || decoded.premium || decoded.plan) {
      console.log('\n📋 ' + t('account.subscription'));
      if (decoded.subscription) {
        console.log(`   ${t('account.status', { status: decoded.subscription })}`);
      }
      if (decoded.plan) {
        console.log(`   ${t('account.plan', { plan: decoded.plan })}`);
      }
      if (decoded.premium !== undefined) {
        console.log(`   ${t('account.premium', { status: decoded.premium ? t('account.yes') : t('account.no') })}`);
      }
    }

    console.log('\n' + '='.repeat(60) + '\n');

    process.exit(0);

  } catch (error: any) {
    console.error('\n❌ ' + t('account.fetchFailed') + '\n');
    console.error(`   ${t('account.fetchFailedError', { message: error.message })}\n`);

    if (error.code === 'EACCES' || error.code === 'EPERM') {
      console.error('   ' + t('account.permissionDenied'));
      console.error('   ' + t('account.permissionHint1') + '\n');
      console.error('     ' + t('account.permissionHint2') + '\n');
    } else if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      console.error('   ' + t('account.networkError'));
      console.error('   ' + t('account.networkHint') + '\n');
    }

    process.exit(1);
  }
}

/**
 * Setup graceful shutdown
 */
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    console.log(`\n\n${t('setup.received', { signal })}`);

    if (proxyClient) {
      try {
        await proxyClient.disconnect();
      } catch (error: any) {
        console.error(t('errors.shutdownError', { message: error.message }));
      }
    }

    console.log(t('app.goodbye') + ' 👋\n');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('\n❌ ' + t('errors.uncaughtException', { message: error.message }));
    console.error(error.stack);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any) => {
    console.error('\n❌ ' + t('errors.unhandledRejection', { message: reason?.message || reason }));
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
  detectLocale();

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
    .option('locale', {
      type: 'string',
      description: 'Set locale for CLI output (e.g., en, es, fr, ja, ko, pt, zh-Hans)',
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
    .option('server', {
      alias: 's',
      type: 'string',
      description: 'Proxy server URL override (e.g., cli-na-1.spck.io)',
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
    .fail((msg, err, _yargs) => {
      if (err) throw err; // Preserve stack trace for actual errors
      console.error('\n❌ ' + t('errors.cliError', { message: msg }));
      console.error('\n' + t('errors.cliErrorHint') + '\n');
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

  // Apply --locale if provided
  if (argv.locale) {
    setLocale(argv.locale as string);
  }

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
      serverOverride: argv.server as string | undefined,
    });
  }
}

// Auto-run if executed directly (e.g., via npm start or node dist/index.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: any) => {
    console.error(t('errors.cliError', { message: error.message }));
    process.exit(1);
  });
}
