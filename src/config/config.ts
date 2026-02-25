/**
 * Configuration management for spck-cli server
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServerConfig } from '../types.js';
import { getProjectFilePath } from '../utils/project-dir.js';
import { t } from '../i18n/index.js';

const DEFAULT_CONFIG_FILENAME = 'spck-cli.config.json';

/**
 * Load server configuration from file
 * If config file doesn't exist, runs setup wizard
 * @throws {ConfigNotFoundError} if file doesn't exist
 * @throws {Error} with code 'CORRUPTED' if file is corrupted
 */
export function loadConfig(configPath?: string): ServerConfig {
  // If a custom config path is provided, use it as-is
  // Otherwise use the default location in the project directory
  const fullPath = configPath
    ? path.resolve(process.cwd(), configPath)
    : getProjectFilePath(process.cwd(), DEFAULT_CONFIG_FILENAME);

  if (!fs.existsSync(fullPath)) {
    console.log('\n' + t('config.fileNotFound', { path: fullPath }));
    console.log(t('config.fileNotFoundHint') + '\n');

    // Signal to caller that setup is needed
    throw new ConfigNotFoundError(fullPath);
  }

  try {
    const configData = fs.readFileSync(fullPath, 'utf8');
    const config: ServerConfig = JSON.parse(configData);

    // Validate required fields
    validateConfig(config);

    return config;
  } catch (error: any) {
    // JSON parse error or validation error
    if (error instanceof SyntaxError || (error.message && error.message.includes('Invalid'))) {
      console.warn('⚠️  ' + t('config.fileCorrupted', { path: fullPath }));
      console.warn('   ' + t('config.fileCorruptedHint') + '\n');
      const corruptedError: any = new Error('Configuration file is corrupted');
      corruptedError.code = 'CORRUPTED';
      corruptedError.path = fullPath;
      corruptedError.originalError = error;
      throw corruptedError;
    }
    // Other errors (permission, etc.)
    throw error;
  }
}

/**
 * Custom error for missing configuration
 */
export class ConfigNotFoundError extends Error {
  constructor(public configPath: string) {
    super(`Configuration file not found: ${configPath}`);
    this.name = 'ConfigNotFoundError';
  }
}

/**
 * Save server configuration to file
 * @throws {Error} with code 'EACCES' for permission errors
 * @throws {Error} with code 'ENOSPC' for disk full errors
 */
export function saveConfig(config: ServerConfig, configPath?: string): void {
  // If a custom config path is provided, use it as-is
  // Otherwise use the default location in the project directory
  const fullPath = configPath
    ? path.resolve(process.cwd(), configPath)
    : getProjectFilePath(process.cwd(), DEFAULT_CONFIG_FILENAME);

  try {
    // Ensure directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Validate before saving
    validateConfig(config);

    // Write config file
    fs.writeFileSync(fullPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (error: any) {
    // Add context to error
    error.path = error.path || fullPath;
    error.operation = 'save config';
    throw error;
  }
}

/**
 * Validate configuration
 */
function validateConfig(config: ServerConfig): void {
  if (!config.version || config.version !== 1) {
    throw new Error('Invalid config version. Expected version 1.');
  }

  if (!config.root || typeof config.root !== 'string') {
    throw new Error('Invalid or missing root directory in configuration.');
  }

  if (!fs.existsSync(config.root)) {
    throw new Error(`Root directory does not exist: ${config.root}`);
  }

  if (!config.terminal || typeof config.terminal !== 'object') {
    throw new Error('Invalid or missing terminal configuration.');
  }

  if (typeof config.terminal.enabled !== 'boolean') {
    throw new Error('Terminal enabled must be a boolean.');
  }

  if (!config.security || typeof config.security !== 'object') {
    throw new Error('Invalid or missing security configuration.');
  }

  if (!config.filesystem || typeof config.filesystem !== 'object') {
    throw new Error('Invalid or missing filesystem configuration.');
  }
}

/**
 * Get current directory name for default server name
 */
function getDefaultServerName(): string {
  const cwd = process.cwd();
  return path.basename(cwd);
}

/**
 * Create default configuration template
 */
export function createDefaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    version: 1,
    root: process.cwd(),
    name: getDefaultServerName(),
    terminal: {
      enabled: true,
      maxBufferedLines: 5000,
      maxTerminals: 10,
    },
    security: {
      userAuthenticationEnabled: false,
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
      ],
    },
    ...overrides,
  };
}

/**
 * Parse file size string to bytes
 */
export function parseFileSize(sizeStr: string): number {
  const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!match) {
    throw new Error(`Invalid file size format: ${sizeStr}`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();

  const multipliers: { [key: string]: number } = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  };

  return value * multipliers[unit];
}
