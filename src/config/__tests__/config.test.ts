/**
 * Unit tests for config management
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  loadConfig,
  saveConfig,
  ConfigNotFoundError,
  createDefaultConfig,
  parseFileSize,
} from '../config';
import { ServerConfig } from '../../types';

// Mock fs module
jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('config', () => {
  const mockCwd = '/mock/project';
  const defaultConfigPath = `${mockCwd}/.spck-editor/spck-networking.config.json`;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('loadConfig()', () => {
    const validConfig: ServerConfig = {
      version: 1,
      root: '/mock/root',
      proxyUrl: 'wss://proxy.example.com',
      terminal: {
        enabled: true,
        maxBufferedLines: 5000,
        maxTerminals: 10,
      },
      security: {
        userAuthenticationEnabled: false,
      },
      filesystem: {
        maxFileSize: '100MB',
        watchIgnorePatterns: ['node_modules/**'],
      },
    };

    beforeEach(() => {
      // Mock root directory exists for validation
      mockFs.existsSync.mockImplementation((path: any) => {
        if (path === '/mock/root') return true;
        return false;
      });
    });

    it('should throw ConfigNotFoundError if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => loadConfig()).toThrow(ConfigNotFoundError);
    });

    it('should load and return valid config', () => {
      mockFs.existsSync.mockImplementation((path: any) => {
        // Config file and root directory exist
        return true;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(validConfig));

      const result = loadConfig();

      expect(result).toEqual(validConfig);
    });

    it('should throw CORRUPTED error for invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('not valid json{');

      expect(() => {
        try {
          loadConfig();
        } catch (error: any) {
          expect(error.code).toBe('CORRUPTED');
          throw error;
        }
      }).toThrow();
    });

    it('should throw CORRUPTED error for invalid version', () => {
      const invalidConfig = {
        ...validConfig,
        version: 999,
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidConfig));

      expect(() => {
        try {
          loadConfig();
        } catch (error: any) {
          expect(error.code).toBe('CORRUPTED');
          throw error;
        }
      }).toThrow();
    });

    it('should throw CORRUPTED error for missing root', () => {
      const invalidConfig = {
        ...validConfig,
        root: undefined,
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidConfig));

      expect(() => {
        try {
          loadConfig();
        } catch (error: any) {
          expect(error.code).toBe('CORRUPTED');
          throw error;
        }
      }).toThrow();
    });

    it('should throw error if root directory does not exist', () => {
      mockFs.existsSync.mockImplementation((path: any) => {
        // Config exists, but root doesn't
        if (path.includes('.spck-editor')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(validConfig));

      expect(() => loadConfig()).toThrow('Root directory does not exist');
    });

    it('should use custom config path when provided', () => {
      const customPath = 'custom/config.json';
      mockFs.existsSync.mockReturnValue(false);

      expect(() => loadConfig(customPath)).toThrow(ConfigNotFoundError);
    });
  });

  describe('saveConfig()', () => {
    const validConfig: ServerConfig = {
      version: 1,
      root: mockCwd,
      proxyUrl: 'wss://proxy.example.com',
      terminal: {
        enabled: true,
        maxBufferedLines: 5000,
        maxTerminals: 10,
      },
      security: {
        userAuthenticationEnabled: false,
      },
      filesystem: {
        maxFileSize: '100MB',
        watchIgnorePatterns: [],
      },
    };

    beforeEach(() => {
      // Mock root directory exists for validation
      mockFs.existsSync.mockImplementation((path: any) => {
        if (path === mockCwd) return true;
        return false;
      });
      mockFs.mkdirSync.mockReturnValue(undefined);
      mockFs.writeFileSync.mockReturnValue(undefined);
    });

    it('should create directory if it does not exist', () => {
      mockFs.existsSync.mockImplementation((path: any) => {
        // Root exists, but .spck-editor doesn't
        if (path === mockCwd) return true;
        return false;
      });

      saveConfig(validConfig);

      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });

    it('should write config file', () => {
      mockFs.existsSync.mockReturnValue(true);

      saveConfig(validConfig);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('spck-networking.config.json'),
        JSON.stringify(validConfig, null, 2),
        'utf8'
      );
    });

    it('should validate config before saving', () => {
      const invalidConfig = {
        ...validConfig,
        version: 999, // Invalid version
      } as any;

      expect(() => saveConfig(invalidConfig)).toThrow('Invalid config version');
    });

    it('should throw error with operation context on write failure', () => {
      const mockError: any = new Error('ENOSPC');
      mockError.code = 'ENOSPC';
      mockFs.writeFileSync.mockImplementation(() => {
        throw mockError;
      });
      mockFs.existsSync.mockReturnValue(true);

      expect(() => {
        try {
          saveConfig(validConfig);
        } catch (error: any) {
          expect(error.operation).toBe('save config');
          throw error;
        }
      }).toThrow();
    });
  });

  describe('createDefaultConfig()', () => {
    it('should create config with default values', () => {
      const config = createDefaultConfig();

      expect(config.version).toBe(1);
      expect(config.root).toBe(mockCwd);
      expect(config.proxyUrl).toBe('wss://proxy.spck.io:3002');
      expect(config.terminal.enabled).toBe(true);
      expect(config.security.userAuthenticationEnabled).toBe(false);
    });

    it('should merge overrides with defaults', () => {
      const overrides = {
        root: '/custom/root',
        terminal: {
          enabled: false,
          maxBufferedLines: 1000,
          maxTerminals: 5,
        },
      };

      const config = createDefaultConfig(overrides);

      expect(config.root).toBe('/custom/root');
      expect(config.terminal.enabled).toBe(false);
      expect(config.terminal.maxBufferedLines).toBe(1000);
      expect(config.proxyUrl).toBe('wss://proxy.spck.io:3002'); // Still has default
    });
  });

  describe('parseFileSize()', () => {
    it('should parse bytes correctly', () => {
      expect(parseFileSize('100B')).toBe(100);
      expect(parseFileSize('100')).toBe(100);
    });

    it('should parse kilobytes correctly', () => {
      expect(parseFileSize('1KB')).toBe(1024);
      expect(parseFileSize('10KB')).toBe(10240);
    });

    it('should parse megabytes correctly', () => {
      expect(parseFileSize('1MB')).toBe(1024 * 1024);
      expect(parseFileSize('100MB')).toBe(100 * 1024 * 1024);
    });

    it('should parse gigabytes correctly', () => {
      expect(parseFileSize('1GB')).toBe(1024 * 1024 * 1024);
      expect(parseFileSize('2GB')).toBe(2 * 1024 * 1024 * 1024);
    });

    it('should handle decimal values', () => {
      expect(parseFileSize('1.5MB')).toBe(1.5 * 1024 * 1024);
      expect(parseFileSize('0.5GB')).toBe(0.5 * 1024 * 1024 * 1024);
    });

    it('should be case insensitive', () => {
      expect(parseFileSize('1mb')).toBe(1024 * 1024);
      expect(parseFileSize('1MB')).toBe(1024 * 1024);
      expect(parseFileSize('1Mb')).toBe(1024 * 1024);
    });

    it('should handle spaces', () => {
      expect(parseFileSize('100 MB')).toBe(100 * 1024 * 1024);
    });

    it('should throw error for invalid format', () => {
      expect(() => parseFileSize('invalid')).toThrow('Invalid file size format');
      expect(() => parseFileSize('100XB')).toThrow('Invalid file size format');
      expect(() => parseFileSize('')).toThrow('Invalid file size format');
    });
  });

  describe('ConfigNotFoundError', () => {
    it('should create error with config path', () => {
      const error = new ConfigNotFoundError('/path/to/config.json');

      expect(error.name).toBe('ConfigNotFoundError');
      expect(error.message).toContain('/path/to/config.json');
      expect(error.configPath).toBe('/path/to/config.json');
    });

    it('should be instance of Error', () => {
      const error = new ConfigNotFoundError('/path');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ConfigNotFoundError);
    });
  });
});
