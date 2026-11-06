/**
 * Interactive setup wizard for spck-cli
 * Configures CLI to connect to proxy server
 */

import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { ServerConfig } from '../types.js';
import { saveConfig, createDefaultConfig } from '../config/config.js';
import { ensureProjectDir, isDirectory } from '../utils/project-dir.js';
import { ESCAPE_TIMEOUT_MS } from '../dashboard/screen.js';
import { gitignoreExists, isSpckEditorIgnored, addSpckEditorToGitignore } from '../utils/gitignore.js';
import { t } from '../i18n/index.js';

const USER_AUTH_DOCS_URL = 'https://docs.spck.io/en/cli-config#user-authentication';

/** Ctrl+C or Ctrl+D at a prompt, which closes the readline interface. */
class SetupCancelled extends Error {}

/**
 * Create readline interface
 */
function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // stdin keeps the timeout of whichever reader attaches first, and a first
    // run reaches the dashboard after this prompt
    escapeCodeTimeout: ESCAPE_TIMEOUT_MS,
  });
}

/**
 * Prompt user for input
 */
function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new SetupCancelled());
    rl.once('close', onClose);
    rl.question(query, (answer) => {
      rl.off('close', onClose);
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
 * Turn a typed path into an absolute one. The shell doesn't expand ~ in an
 * answer to a prompt, so that is done here.
 */
function resolveRootInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return process.cwd();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

async function questionRootDir(rl: readline.Interface): Promise<string> {
  for (;;) {
    const answer = await question(rl, t('setup.rootDirPrompt', { default: process.cwd() }));
    const rootPath = resolveRootInput(answer);
    if (isDirectory(rootPath)) return rootPath;
    console.log(t('setup.rootDirInvalid', { path: rootPath }) + '\n');
  }
}

/** A positive whole number, or the default for blank / invalid input. */
function parsePositiveInt(input: string, defaultValue: number): number {
  const value = parseInt(input, 10);
  return value > 0 ? value : defaultValue;
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

    const rootPath = await questionRootDir(rl);

    const defaultConfig = createDefaultConfig();

    // Terminal service
    console.log('\n--- ' + t('setup.terminalConfig') + ' ---\n');
    console.log(t('setup.terminalDescription'));

    const terminalEnabled = await questionYesNo(
      rl,
      t('setup.terminalPrompt'),
      true
    );

    let maxBufferedLines = 5000;
    let maxTerminals = 10;

    // Advanced terminal configuration
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
        maxBufferedLines = parsePositiveInt(bufferInput, maxBufferedLines);

        console.log('   ' + t('setup.maxBufferHint') + '\n');

        const maxTermInput = await question(
          rl,
          t('setup.maxTerminalsPrompt', { default: String(maxTerminals) })
        );
        maxTerminals = parsePositiveInt(maxTermInput, maxTerminals);
      }
    }

    // Browser proxy configuration
    console.log('\n--- ' + t('setup.browserProxyConfig') + ' ---\n');
    console.log(t('setup.browserProxyDescription') + '\n');

    const browserProxyEnabled = await questionYesNo(
      rl,
      t('setup.browserProxyPrompt'),
      true
    );

    // ACP (local AI agent) configuration
    console.log('\n--- ' + t('setup.acpConfig') + ' ---\n');
    console.log(t('setup.acpDescription1'));
    console.log(t('setup.acpDescription2') + '\n');

    const acpEnabled = await questionYesNo(
      rl,
      t('setup.acpPrompt'),
      true
    );

    // Security configuration
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

    // .gitignore configuration (advanced)
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
      acp: {
        enabled: acpEnabled
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
    // Nothing is saved until the last answer, so there is nothing to undo
    if (error instanceof SetupCancelled) {
      console.log('');
      process.exit(130);
    }
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
  console.log('  ' + t('setup.summaryAcp', { status: config.acp?.enabled !== false ? t('setup.summaryEnabled') : t('setup.summaryDisabled') }));
  console.log('');
}
