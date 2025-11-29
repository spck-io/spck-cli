/**
 * Configuration management for spck-networking server
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServerConfig } from '../types';

const DEFAULT_CONFIG_PATH = '.spck-editor/spck-networking.config.json';

/**
 * Load server configuration from file
 * If config file doesn't exist, runs setup wizard
 */
export function loadConfig(configPath?: string): ServerConfig {
  const resolvedPath = configPath || DEFAULT_CONFIG_PATH;
  const fullPath = path.resolve(process.cwd(), resolvedPath);

  if (!fs.existsSync(fullPath)) {
    console.log(`\nConfiguration file not found: ${fullPath}`);
    console.log('Running setup wizard to create initial configuration...\n');

    // Signal to caller that setup is needed
    throw new ConfigNotFoundError(fullPath);
  }

  const configData = fs.readFileSync(fullPath, 'utf8');
  const config: ServerConfig = JSON.parse(configData);

  // Validate required fields
  validateConfig(config);

  return config;
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
 */
export function saveConfig(config: ServerConfig, configPath?: string): void {
  const resolvedPath = configPath || DEFAULT_CONFIG_PATH;
  const fullPath = path.resolve(process.cwd(), resolvedPath);

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Validate before saving
  validateConfig(config);

  // Write config file
  fs.writeFileSync(fullPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Validate configuration
 */
function validateConfig(config: ServerConfig): void {
  if (!config.version || config.version !== 1) {
    throw new Error('Invalid config version. Expected version 1.');
  }

  if (!config.port || typeof config.port !== 'number') {
    throw new Error('Invalid or missing port in configuration.');
  }

  if (!config.root || typeof config.root !== 'string') {
    throw new Error('Invalid or missing root directory in configuration.');
  }

  if (!fs.existsSync(config.root)) {
    throw new Error(`Root directory does not exist: ${config.root}`);
  }

  // Allow empty allowedUids for development/setup
  // But warn the user
  if (!Array.isArray(config.allowedUids) || config.allowedUids.length === 0) {
    console.warn('⚠️  WARNING: No allowed UIDs configured. Authentication will fail.');
    console.warn('   Update "allowedUids" in the config file or run --setup');
  }

  if (!config.terminal || typeof config.terminal !== 'object') {
    throw new Error('Invalid or missing terminal configuration.');
  }

  if (!config.filesystem || typeof config.filesystem !== 'object') {
    throw new Error('Invalid or missing filesystem configuration.');
  }
}

/**
 * Create default configuration template
 */
export function createDefaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    version: 1,
    port: 3000,
    root: process.cwd(),
    allowedUids: [],
    firebaseProjectId: '',
    terminal: {
      maxBufferedLines: 10000,
      maxTerminals: 10,
    },
    filesystem: {
      maxFileSize: '100MB',
      watchIgnorePatterns: ['.git', 'node_modules', '*.log', '.DS_Store', 'dist', 'build'],
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
