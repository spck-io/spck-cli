/**
 * Unit tests for credentials management
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as jwt from 'jsonwebtoken';
import {
  loadCredentials,
  saveCredentials,
  loadConnectionSettings,
  saveConnectionSettings,
  isTokenExpired,
  isServerTokenExpired,
  getCredentialsPath,
  getConnectionSettingsPath,
  clearCredentials,
  clearConnectionSettings,
} from '../credentials';
import { FirebaseCredentials } from '../../types';

// Mock modules
jest.mock('fs');
jest.mock('os');
jest.mock('jsonwebtoken');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

describe('credentials', () => {
  const mockHomedir = '/mock/home';
  const mockCwd = '/mock/project';

  beforeEach(() => {
    jest.clearAllMocks();
    mockOs.homedir.mockReturnValue(mockHomedir);
    jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);

    // Mock JWT decode to return valid token by default
    mockJwt.decode.mockReturnValue({
      exp: Math.floor((Date.now() + 3600000) / 1000), // 1 hour from now in seconds
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getCredentialsPath()', () => {
    it('should return path in user home directory', () => {
      const path = getCredentialsPath();
      expect(path).toBe(`${mockHomedir}/.spck-editor/.credentials.json`);
    });
  });

  describe('getConnectionSettingsPath()', () => {
    it('should return path in current working directory', () => {
      const path = getConnectionSettingsPath();
      expect(path).toBe(`${mockCwd}/.spck-editor/connection-settings.json`);
    });
  });

  describe('loadCredentials()', () => {
    it('should return null if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = loadCredentials();

      expect(result).toBeNull();
    });

    it('should load and return valid credentials', () => {
      const mockCredentials: FirebaseCredentials = {
        firebaseToken: 'mock-token',
        firebaseTokenExpiry: Date.now() + 3600000,
        userId: 'user-123',
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockCredentials));

      const result = loadCredentials();

      expect(result).toEqual(mockCredentials);
    });

    it('should throw CORRUPTED error for invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json{');

      expect(() => loadCredentials()).toThrow('Credentials file is corrupted');
      expect(() => {
        try {
          loadCredentials();
        } catch (error: any) {
          expect(error.code).toBe('CORRUPTED');
          throw error;
        }
      }).toThrow();
    });

    it('should throw CORRUPTED error for missing firebaseToken', () => {
      const invalidCredentials = {
        userId: 'user-123',
        firebaseTokenExpiry: Date.now(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidCredentials));

      expect(() => {
        try {
          loadCredentials();
        } catch (error: any) {
          expect(error.code).toBe('CORRUPTED');
          throw error;
        }
      }).toThrow();
    });

    it('should throw CORRUPTED error for missing userId', () => {
      const invalidCredentials = {
        firebaseToken: 'mock-token',
        firebaseTokenExpiry: Date.now(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidCredentials));

      expect(() => {
        try {
          loadCredentials();
        } catch (error: any) {
          expect(error.code).toBe('CORRUPTED');
          throw error;
        }
      }).toThrow();
    });
  });

  describe('saveCredentials()', () => {
    const mockCredentials: FirebaseCredentials = {
      firebaseToken: 'mock-token',
      firebaseTokenExpiry: Date.now() + 3600000,
      userId: 'user-123',
    };

    it('should create directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockReturnValue(undefined);
      mockFs.writeFileSync.mockReturnValue(undefined);

      saveCredentials(mockCredentials);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        `${mockHomedir}/.spck-editor`,
        { recursive: true, mode: 0o700 }
      );
    });

    it('should write credentials file with correct permissions', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockReturnValue(undefined);

      saveCredentials(mockCredentials);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        `${mockHomedir}/.spck-editor/.credentials.json`,
        JSON.stringify(mockCredentials, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    });

    it('should throw error with operation context on write failure', () => {
      mockFs.existsSync.mockReturnValue(true);
      const mockError: any = new Error('ENOSPC: no space left');
      mockError.code = 'ENOSPC';
      mockFs.writeFileSync.mockImplementation(() => {
        throw mockError;
      });

      expect(() => {
        try {
          saveCredentials(mockCredentials);
        } catch (error: any) {
          expect(error.operation).toBe('save credentials');
          throw error;
        }
      }).toThrow();
    });
  });

  describe('loadConnectionSettings()', () => {
    it('should return null if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = loadConnectionSettings();

      expect(result).toBeNull();
    });

    it('should load and return valid connection settings', () => {
      const mockSettings = {
        serverToken: 'server-token',
        serverTokenExpiry: Date.now() + 3600000,
        clientId: 'client-123',
        secret: 'secret-abc',
        userId: 'user-123',
        connectedAt: Date.now(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockSettings));

      const result = loadConnectionSettings();

      expect(result).toEqual(mockSettings);
    });

    it('should throw CORRUPTED error for invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('not valid json');

      expect(() => {
        try {
          loadConnectionSettings();
        } catch (error: any) {
          expect(error.code).toBe('CORRUPTED');
          throw error;
        }
      }).toThrow();
    });

    it('should throw CORRUPTED error for missing required fields', () => {
      const invalidSettings = {
        serverToken: 'token',
        // missing clientId and secret
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidSettings));

      expect(() => {
        try {
          loadConnectionSettings();
        } catch (error: any) {
          expect(error.code).toBe('CORRUPTED');
          throw error;
        }
      }).toThrow();
    });
  });

  describe('saveConnectionSettings()', () => {
    const mockSettings = {
      serverToken: 'server-token',
      serverTokenExpiry: Date.now() + 3600000,
      clientId: 'client-123',
      secret: 'secret-abc',
      userId: 'user-123',
      connectedAt: Date.now(),
    };

    it('should create directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockReturnValue(undefined);
      mockFs.writeFileSync.mockReturnValue(undefined);

      saveConnectionSettings(mockSettings);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        `${mockCwd}/.spck-editor`,
        { recursive: true }
      );
    });

    it('should write settings file', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockReturnValue(undefined);

      saveConnectionSettings(mockSettings);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        `${mockCwd}/.spck-editor/connection-settings.json`,
        JSON.stringify(mockSettings, null, 2),
        'utf8'
      );
    });

    it('should throw error with operation context on write failure', () => {
      mockFs.existsSync.mockReturnValue(true);
      const mockError: any = new Error('EACCES: permission denied');
      mockError.code = 'EACCES';
      mockFs.writeFileSync.mockImplementation(() => {
        throw mockError;
      });

      expect(() => {
        try {
          saveConnectionSettings(mockSettings);
        } catch (error: any) {
          expect(error.operation).toBe('save connection settings');
          throw error;
        }
      }).toThrow();
    });
  });

  describe('isTokenExpired()', () => {
    it('should return true if token expiry has passed', () => {
      const expiredCredentials: FirebaseCredentials = {
        firebaseToken: 'mock-token',
        firebaseTokenExpiry: Date.now() - 1000, // 1 second ago
        userId: 'user-123',
      };

      expect(isTokenExpired(expiredCredentials)).toBe(true);
    });

    it('should return false if token is still valid', () => {
      const validCredentials: FirebaseCredentials = {
        firebaseToken: 'mock-token',
        firebaseTokenExpiry: Date.now() + 3600000, // 1 hour from now
        userId: 'user-123',
      };

      expect(isTokenExpired(validCredentials)).toBe(false);
    });
  });

  describe('isServerTokenExpired()', () => {
    it('should return true if settings is null', () => {
      expect(isServerTokenExpired(null)).toBe(true);
    });

    it('should return true if serverTokenExpiry is missing', () => {
      expect(isServerTokenExpired({ serverToken: 'token' })).toBe(true);
    });

    it('should return true if token has expired', () => {
      const expiredSettings = {
        serverToken: 'token',
        serverTokenExpiry: Date.now() - 1000,
      };

      expect(isServerTokenExpired(expiredSettings)).toBe(true);
    });

    it('should return false if token is still valid', () => {
      const validSettings = {
        serverToken: 'token',
        serverTokenExpiry: Date.now() + 3600000,
      };

      expect(isServerTokenExpired(validSettings)).toBe(false);
    });
  });

  describe('clearCredentials()', () => {
    it('should delete credentials file if it exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.unlinkSync.mockReturnValue(undefined);

      clearCredentials();

      expect(mockFs.unlinkSync).toHaveBeenCalledWith(
        `${mockHomedir}/.spck-editor/.credentials.json`
      );
    });

    it('should do nothing if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      clearCredentials();

      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('clearConnectionSettings()', () => {
    it('should delete settings file if it exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.unlinkSync.mockReturnValue(undefined);

      clearConnectionSettings();

      expect(mockFs.unlinkSync).toHaveBeenCalledWith(
        `${mockCwd}/.spck-editor/connection-settings.json`
      );
    });

    it('should do nothing if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      clearConnectionSettings();

      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
