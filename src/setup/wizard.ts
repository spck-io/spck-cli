/**
 * Interactive setup wizard for spck-cli
 * Configures CLI to connect to proxy server
 */

import * as readline from 'readline';
import { ServerConfig } from '../types.js';
import { saveConfig, createDefaultConfig } from '../config/config.js';
import { ensureProjectDir } from '../utils/project-dir.js';
import { gitignoreExists, isSpckEditorIgnored, addSpckEditorToGitignore } from '../utils/gitignore.js';

const USER_AUTH_DOCS_URL = 'https://docs.spck.io/networking/user-auth';

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
  console.log('     Spck Networking CLI - Initial Setup');
  console.log('='.repeat(60) + '\n');

  console.log('This wizard will help you configure the Spck Networking CLI.');
  console.log('The CLI connects to a proxy server to enable remote access');
  console.log('to your local filesystem, git, and terminal.\n');

  try {
    // Step 1: Root directory
    console.log('--- Project Configuration ---\n');

    const root = await question(
      rl,
      `Root directory to serve [${process.cwd()}]: `
    );
    const rootPath = root.trim() || process.cwd();

    // Step 1.5: Server name (for QR code identification)
    const defaultConfig = createDefaultConfig();

    // Step 2: Terminal service
    console.log('\n--- Terminal Configuration ---\n');
    console.log('Terminal service allows remote shell access to your machine.');

    const terminalEnabled = await questionYesNo(
      rl,
      'Enable terminal service? [Y/n]: ',
      true
    );

    let maxBufferedLines = 5000;
    let maxTerminals = 10;

    // Step 4: Advanced terminal configuration
    if (terminalEnabled) {
      const advancedTerminal = await questionYesNo(
        rl,
        '\nConfigure advanced terminal settings? [y/N]: ',
        false
      );

      if (advancedTerminal) {
        console.log('');
        const bufferInput = await question(
          rl,
          `Maximum buffer lines (terminal history) [${maxBufferedLines}]: `
        );
        maxBufferedLines = parseInt(bufferInput) || 5000;

        console.log('   (Larger buffer stores more history but may slow synchronization)\n');

        const maxTermInput = await question(
          rl,
          `Maximum terminal processes [${maxTerminals}]: `
        );
        maxTerminals = parseInt(maxTermInput) || 10;
      }
    }

    // Step 5: Security configuration
    console.log('\n--- Security Configuration ---\n');
    console.log('Additional user authentication adds an extra security layer');
    console.log('by requiring the client to verify their Firebase identity.');
    console.log('This increases initial connection time by ~3-15 seconds.');
    console.log(`Learn more: ${USER_AUTH_DOCS_URL}\n`);

    const userAuthEnabled = await questionYesNo(
      rl,
      'Enable additional user authentication? [y/N]: ',
      false
    );

    // Step 6: .gitignore configuration (advanced)
    let shouldAddToGitignore = false;

    if (gitignoreExists(rootPath)) {
      if (!isSpckEditorIgnored(rootPath)) {
        console.log('\n--- Git Configuration ---\n');
        console.log('A .gitignore file was detected in your project directory.');
        console.log('It is recommended to add .spck-editor/ to .gitignore to prevent');
        console.log('accidentally committing the symlink to version control.\n');

        shouldAddToGitignore = await questionYesNo(
          rl,
          'Add .spck-editor/ to .gitignore? [Y/n]: ',
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
        console.log('\n✅ Added .spck-editor/ to .gitignore');
      } catch (error: any) {
        console.warn(`\n⚠️  Failed to update .gitignore: ${error.message}`);
        console.warn('   You can manually add .spck-editor/ to your .gitignore file.');
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Configuration saved successfully!');
    console.log('='.repeat(60) + '\n');

    displayConfigSummary(config);

    return config;

  } catch (error: any) {
    rl.close();
    console.error('\n❌ Setup failed:', error.message);
    throw error;
  }
}

/**
 * Display configuration summary
 */
function displayConfigSummary(config: ServerConfig): void {
  console.log('Configuration summary:');
  console.log(`  Server name: ${config.name || 'Not set'}`);
  console.log(`  Root directory: ${config.root}`);
  console.log(`  Terminal service: ${config.terminal.enabled ? 'Enabled' : 'Disabled'}`);

  if (config.terminal.enabled) {
    console.log(`    - Max buffer lines: ${config.terminal.maxBufferedLines}`);
    console.log(`    - Max processes: ${config.terminal.maxTerminals}`);
  }

  console.log(`  User authentication: ${config.security.userAuthenticationEnabled ? 'Enabled' : 'Disabled'}`);
  console.log('');
}
