/**
 * Unit tests for credentials management
 */

import * as fs from 'fs';
import * as os from 'os';
import {
  loadCredentials,
  saveCredentials,
  loadConnectionSettings,
  saveConnectionSettings,
  isServerTokenExpired,
  getCredentialsPath,
  getConnectionSettingsPath,
  clearCredentials,
  clearConnectionSettings,
} from '../credentials.js';
import { StoredCredentials } from '../../types.js';

// Mock modules
jest.mock('fs');
jest.mock('os');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

describe('credentials', () => {
  const mockHomedir = '/mock/home';
  const mockCwd = '/mock/project';

  beforeEach(() => {
    jest.clearAllMocks();
    mockOs.homedir.mockReturnValue(mockHomedir);
    jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
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

    it('should load and return valid stored credentials', () => {
      const mockCredentials: StoredCredentials = {
        refreshToken: 'mock-refresh-token',
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

    it('should throw CORRUPTED error for missing refreshToken', () => {
      const invalidCredentials = {
        userId: 'user-123',
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
        refreshToken: 'mock-refresh-token',
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

    it('should only return refreshToken and userId even if file has extra fields', () => {
      const storedWithExtra = {
        refreshToken: 'mock-refresh-token',
        userId: 'user-123',
        firebaseToken: 'old-token',
        firebaseTokenExpiry: Date.now(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(storedWithExtra));

      const result = loadCredentials();

      // Should only return the stored credentials fields
      expect(result).toEqual({
        refreshToken: 'mock-refresh-token',
        userId: 'user-123',
      });
    });
  });

  describe('saveCredentials()', () => {
    const mockCredentials: StoredCredentials = {
      refreshToken: 'mock-refresh-token',
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

    it('should write only refreshToken and userId with correct permissions', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockReturnValue(undefined);

      saveCredentials(mockCredentials);

      // Should only persist refreshToken + userId
      const expectedStored: StoredCredentials = {
        refreshToken: 'mock-refresh-token',
        userId: 'user-123',
      };

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        `${mockHomedir}/.spck-editor/.credentials.json`,
        JSON.stringify(expectedStored, null, 2),
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
        { recursive: true, mode: 0o700 }
      );
    });

    it('should write settings file with restricted permissions', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockReturnValue(undefined);

      saveConnectionSettings(mockSettings);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        `${mockCwd}/.spck-editor/connection-settings.json`,
        JSON.stringify(mockSettings, null, 2),
        { encoding: 'utf8', mode: 0o600 }
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
