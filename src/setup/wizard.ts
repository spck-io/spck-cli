/**
 * Interactive setup wizard for spck-cli
 * Configures CLI to connect to proxy server
 */

import * as readline from 'readline';
import { ServerConfig } from '../types.js';
import { saveConfig, createDefaultConfig } from '../config/config.js';
import { ensureProjectDir } from '../utils/project-dir.js';
import { gitignoreExists, isSpckEditorIgnored, addSpckEditorToGitignore } from '../utils/gitignore.js';
import { t } from '../i18n/index.js';

const USER_AUTH_DOCS_URL = 'https://spck.io/docs/cli#user-authentication';

/**
 * Create readline interface
 */
function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompt user for input
 */
function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Ask yes/no question
 */
async function questionYesNo(
  rl: readline.Interface,
  query: string,
  defaultValue: boolean
): Promise<boolean> {
  const answer = await question(rl, query);
  const normalized = answer.trim().toLowerCase();

  if (normalized === '') {
    return defaultValue;
  }

  return normalized === 'y' || normalized === 'yes';
}

/**
 * Run the setup wizard
 */
export async function runSetup(configPath?: string): Promise<ServerConfig> {
  const rl = createPrompt();

  console.log('\n' + '='.repeat(60));
  console.log('     ' + t('setup.title'));
  console.log('='.repeat(60) + '\n');

  console.log(t('setup.description1'));
  console.log(t('setup.description2'));
  console.log(t('setup.description3') + '\n');

  try {
    // Step 1: Root directory
    console.log('--- ' + t('setup.projectConfig') + ' ---\n');

    const root = await question(
      rl,
      t('setup.rootDirPrompt', { default: process.cwd() })
    );
    const rootPath = root.trim() || process.cwd();

    // Step 1.5: Server name (for QR code identification)
    const defaultConfig = createDefaultConfig();

    // Step 2: Terminal service
    console.log('\n--- ' + t('setup.terminalConfig') + ' ---\n');
    console.log(t('setup.terminalDescription'));

    const terminalEnabled = await questionYesNo(
      rl,
      t('setup.terminalPrompt'),
      true
    );

    let maxBufferedLines = 5000;
    let maxTerminals = 10;

    // Step 4: Advanced terminal configuration
    if (terminalEnabled) {
      const advancedTerminal = await questionYesNo(
        rl,
        '\n' + t('setup.advancedTerminalPrompt'),
        false
      );

      if (advancedTerminal) {
        console.log('');
        const bufferInput = await question(
          rl,
          t('setup.maxBufferPrompt', { default: String(maxBufferedLines) })
        );
        maxBufferedLines = parseInt(bufferInput) || 5000;

        console.log('   ' + t('setup.maxBufferHint') + '\n');

        const maxTermInput = await question(
          rl,
          t('setup.maxTerminalsPrompt', { default: String(maxTerminals) })
        );
        maxTerminals = parseInt(maxTermInput) || 10;
      }
    }

    // Step 5: Browser proxy configuration
    console.log('\n--- ' + t('setup.browserProxyConfig') + ' ---\n');
    console.log(t('setup.browserProxyDescription') + '\n');

    const browserProxyEnabled = await questionYesNo(
      rl,
      t('setup.browserProxyPrompt'),
      true
    );

    // Step 6: Security configuration
    console.log('\n--- ' + t('setup.securityConfig') + ' ---\n');
    console.log(t('setup.securityDescription1'));
    console.log(t('setup.securityDescription2'));
    console.log(t('setup.securityDescription3'));
    console.log(t('setup.securityDocsHint', { url: USER_AUTH_DOCS_URL }) + '\n');

    const userAuthEnabled = await questionYesNo(
      rl,
      t('setup.securityPrompt'),
      false
    );

    // Step 6: .gitignore configuration (advanced)
    let shouldAddToGitignore = false;

    if (gitignoreExists(rootPath)) {
      if (!isSpckEditorIgnored(rootPath)) {
        console.log('\n--- ' + t('setup.gitConfig') + ' ---\n');
        console.log(t('setup.gitignoreDetected'));
        console.log(t('setup.gitignoreRecommend1'));
        console.log(t('setup.gitignoreRecommend2') + '\n');

        shouldAddToGitignore = await questionYesNo(
          rl,
          t('setup.gitignorePrompt'),
          true
        );
      }
    }

    rl.close();

    // Create configuration
    const config: ServerConfig = {
      version: 1,
      root: rootPath,
      name: defaultConfig.name,
      terminal: {
        enabled: terminalEnabled,
        maxBufferedLines,
        maxTerminals
      },
      security: {
        userAuthenticationEnabled: userAuthEnabled
      },
      browserProxy: {
        enabled: browserProxyEnabled
      },
      filesystem: {
        maxFileSize: '10MB',
        watchIgnorePatterns: [
          '**/.git/**',
          '**/.spck-editor/**',
          '**/node_modules/**',
          '**/*.log',
          '**/.DS_Store',
          '**/dist/**',
          '**/build/**'
        ]
      }
    };

    // Ensure project directory exists (creates symlink)
    ensureProjectDir(config.root);

    // Save configuration
    saveConfig(config, configPath);

    // Add to .gitignore if requested
    if (shouldAddToGitignore) {
      try {
        addSpckEditorToGitignore(config.root);
        console.log('\n✅ ' + t('setup.gitignoreAdded'));
      } catch (error: any) {
        console.warn('\n⚠️  ' + t('setup.gitignoreFailed', { message: error.message }));
        console.warn('   ' + t('setup.gitignoreManualHint'));
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ ' + t('config.saved'));
    console.log('='.repeat(60) + '\n');

    displayConfigSummary(config);

    return config;

  } catch (error: any) {
    rl.close();
    console.error('\n❌ ' + t('setup.setupFailed', { message: error.message }));
    throw error;
  }
}

/**
 * Display configuration summary
 */
function displayConfigSummary(config: ServerConfig): void {
  console.log(t('setup.configSummary'));
  console.log('  ' + t('setup.summaryName', { name: config.name || t('setup.summaryNameNotSet') }));
  console.log('  ' + t('setup.summaryRoot', { root: config.root }));
  console.log('  ' + t('setup.summaryTerminal', { status: config.terminal.enabled ? t('setup.summaryEnabled') : t('setup.summaryDisabled') }));

  if (config.terminal.enabled) {
    console.log('  ' + t('setup.summaryMaxBuffer', { value: String(config.terminal.maxBufferedLines) }));
    console.log('  ' + t('setup.summaryMaxProcesses', { value: String(config.terminal.maxTerminals) }));
  }

  console.log('  ' + t('setup.summaryUserAuth', { status: config.security.userAuthenticationEnabled ? t('setup.summaryEnabled') : t('setup.summaryDisabled') }));
  console.log('  ' + t('setup.summaryBrowserProxy', { status: config.browserProxy?.enabled !== false ? t('setup.summaryEnabled') : t('setup.summaryDisabled') }));
  console.log('');
}
