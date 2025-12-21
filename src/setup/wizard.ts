/**
 * Interactive setup wizard for spck-networking
 * Configures CLI to connect to proxy server
 */

import * as readline from 'readline';
import { ServerConfig } from '../types.js';
import { saveConfig, createDefaultConfig } from '../config/config.js';

const DEFAULT_PROXY_URL = 'wss://proxy.spck.io:3002';
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

    // Step 2: Proxy server URL
    const proxyUrl = await question(
      rl,
      `Proxy server URL [${DEFAULT_PROXY_URL}]: `
    );
    const proxyUrlValue = proxyUrl.trim() || DEFAULT_PROXY_URL;

    // Step 3: Terminal service
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
    console.log('This increases connection time by ~1-2 seconds.');
    console.log(`Learn more: ${USER_AUTH_DOCS_URL}\n`);

    const userAuthEnabled = await questionYesNo(
      rl,
      'Enable additional user authentication? [y/N]: ',
      false
    );

    rl.close();

    // Create configuration
    const config: ServerConfig = {
      version: 1,
      root: rootPath,
      proxyUrl: proxyUrlValue,
      terminal: {
        enabled: terminalEnabled,
        maxBufferedLines,
        maxTerminals
      },
      security: {
        userAuthenticationEnabled: userAuthEnabled
      },
      filesystem: {
        maxFileSize: '100MB',
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

    // Save configuration
    saveConfig(config, configPath);

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
  console.log(`  Root directory: ${config.root}`);
  console.log(`  Proxy server: ${config.proxyUrl}`);
  console.log(`  Terminal service: ${config.terminal.enabled ? 'Enabled' : 'Disabled'}`);

  if (config.terminal.enabled) {
    console.log(`    - Max buffer lines: ${config.terminal.maxBufferedLines}`);
    console.log(`    - Max processes: ${config.terminal.maxTerminals}`);
  }

  console.log(`  User authentication: ${config.security.userAuthenticationEnabled ? 'Enabled' : 'Disabled'}`);
  console.log('');
}
