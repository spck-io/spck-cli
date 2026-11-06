import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../utils/project-dir.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureProjectDir: vi.fn(),
}));
vi.mock('../config/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadCredentials: () => ({ refreshToken: 'token', userId: 'user' }),
  loadConnectionSettings: () => null,
  loadServerPreference: () => 'relay.test',
  saveServerPreference: vi.fn(),
}));
vi.mock('../connection/firebase-auth.js', () => ({
  getValidFirebaseToken: async () => ({ firebaseToken: 'token', userId: 'user' }),
  authenticateWithFirebase: vi.fn(),
  abortCurrentAuth: vi.fn(),
}));
vi.mock('../utils/tool-detection.js', () => ({
  detectTools: async () => ({ git: false, ripgrep: false }),
  displayFeatureSummary: vi.fn(),
}));
vi.mock('../proxy/ProxyClient.js', () => ({
  ProxyClient: class {
    connect = async () => {};
    forceCleanup = () => {};
  },
}));
vi.mock('../rpc/router.js', () => ({ RPCRouter: { initialize: vi.fn() } }));

import { startProxyClient } from '../index.js';
import { RPCRouter } from '../rpc/router.js';

describe('--root', () => {
  let dir: string;
  let configPath: string;
  let configRoot: string;
  let otherRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck-root-'));
    configRoot = fs.mkdirSync(path.join(dir, 'configured'), { recursive: true })!;
    otherRoot = fs.mkdirSync(path.join(dir, 'other'), { recursive: true })!;
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1, root: configRoot, terminal: { enabled: true },
      security: { userAuthenticationEnabled: false }, filesystem: { maxFileSize: '10MB' },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(RPCRouter.initialize).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the given directory without changing the config file', async () => {
    await startProxyClient(configPath, { rootOverride: otherRoot });

    expect(vi.mocked(RPCRouter.initialize).mock.calls[0][0]).toBe(otherRoot);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).root).toBe(configRoot);
  });

  it('serves the configured directory by default', async () => {
    await startProxyClient(configPath);

    expect(vi.mocked(RPCRouter.initialize).mock.calls[0][0]).toBe(configRoot);
  });

  it('refuses a path that is not a directory', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as any);

    await expect(startProxyClient(configPath, { rootOverride: configPath })).rejects.toThrow('exit 1');

    expect(exit).toHaveBeenCalled();
    expect(RPCRouter.initialize).not.toHaveBeenCalled();
  });
});
