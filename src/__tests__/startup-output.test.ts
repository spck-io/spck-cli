import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock('../config/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/config.js')>(),
  loadConfig: vi.fn(),
}));
vi.mock('../utils/project-dir.js', () => ({ ensureProjectDir: vi.fn(), isDirectory: vi.fn(() => true) }));
vi.mock('../config/credentials.js', () => ({
  loadCredentials: vi.fn(), loadConnectionSettings: () => null,
  loadServerPreference: () => 'relay.test', saveServerPreference: vi.fn(),
}));
vi.mock('../connection/firebase-auth.js', () => ({
  getValidFirebaseToken: vi.fn(), authenticateWithFirebase: vi.fn(), abortCurrentAuth: vi.fn(),
}));
vi.mock('../utils/tool-detection.js', () => ({
  detectTools: async () => ({ git: false, ripgrep: false }),
  displayFeatureSummary: () => console.log('Feature summary'),
}));
vi.mock('../proxy/ProxyClient.js', () => ({
  ProxyClient: class { connect = connect; forceCleanup = vi.fn(); },
}));
vi.mock('../rpc/router.js', () => ({ RPCRouter: { initialize: vi.fn() } }));
vi.mock('../setup/wizard.js', () => ({ runSetup: vi.fn(), confirm: vi.fn() }));
vi.mock('../dashboard/Dashboard.js', () => ({ Dashboard: vi.fn(class { start = vi.fn(); }) }));
vi.mock('../dashboard/WakeLock.js', () => ({ WakeLock: class {} }));

import { startProxyClient } from '../index.js';
import { ConfigNotFoundError, createDefaultConfig, loadConfig } from '../config/config.js';
import { loadCredentials } from '../config/credentials.js';
import { authenticateWithFirebase, getValidFirebaseToken } from '../connection/firebase-auth.js';
import { confirm, runSetup } from '../setup/wizard.js';
import { Dashboard } from '../dashboard/Dashboard.js';
import { isDirectory } from '../utils/project-dir.js';

const credentials = {
  firebaseToken: 'token', firebaseTokenExpiry: Date.now() + 3600000, refreshToken: 'refresh', userId: 'user',
};
const originalTTY = {
  stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
};

describe('startup output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadConfig).mockReset().mockReturnValue(createDefaultConfig());
    vi.mocked(isDirectory).mockReturnValue(true);
    vi.mocked(loadCredentials).mockReturnValue({ refreshToken: 'refresh', userId: 'user' });
    vi.mocked(getValidFirebaseToken).mockReset().mockResolvedValue(credentials);
    vi.mocked(authenticateWithFirebase).mockReset().mockImplementation(async (onInteractiveAuth) => {
      onInteractiveAuth?.();
      console.log('Sign-in instructions');
      return credentials;
    });
    connect.mockReset().mockImplementation(async () => { console.log('Connecting to relay'); });
  });

  afterEach(() => {
    for (const [options] of vi.mocked(Dashboard).mock.calls) options.logs.uninstall();
    vi.restoreAllMocks();
    for (const stream of ['stdout', 'stdin'] as const) {
      const descriptor = originalTTY[stream];
      if (descriptor) Object.defineProperty(process[stream], 'isTTY', descriptor);
      else Reflect.deleteProperty(process[stream], 'isTTY');
    }
  });

  it('opens the dashboard without echoing startup logs, retaining them in its log buffer', async () => {
    const log = console.log;
    const exitsBefore = process.listenerCount('exit');
    await startProxyClient();

    expect(log).not.toHaveBeenCalled();
    expect(Dashboard).toHaveBeenCalledOnce();
    const logs = vi.mocked(Dashboard).mock.calls[0][0].logs.entries.map((entry) => entry.text).join('\n');
    expect(logs).toContain('Feature summary');
    expect(logs).toContain('Connecting to relay');
    expect(process.listenerCount('exit')).toBe(exitsBefore);
  });

  it('keeps plain output when stdout is redirected', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    await startProxyClient();

    expect(console.log).toHaveBeenCalledWith('Feature summary');
    expect(console.log).toHaveBeenCalledWith('Connecting to relay');
    expect(Dashboard).not.toHaveBeenCalled();
  });

  it('shows setup instructions and buffers subsequent startup logs', async () => {
    const log = console.log;
    vi.mocked(loadConfig).mockImplementationOnce(() => { throw new ConfigNotFoundError('config.json'); });
    vi.mocked(runSetup).mockImplementationOnce(async () => {
      console.log('Setup instructions');
      return createDefaultConfig();
    });
    await startProxyClient();

    expect(log).toHaveBeenCalledWith('Setup instructions');
    expect(log).not.toHaveBeenCalledWith('Feature summary');
    expect(log).not.toHaveBeenCalledWith('Connecting to relay');
  });

  it.each([false, true])('shows sign-in instructions when authentication is required (stored credentials: %s)', async (stored) => {
    const log = console.log;
    if (stored) {
      vi.mocked(getValidFirebaseToken).mockImplementationOnce(async (_credentials, onInteractiveAuth) => {
        return authenticateWithFirebase(onInteractiveAuth);
      });
    } else {
      vi.mocked(loadCredentials).mockReturnValueOnce(null);
    }
    await startProxyClient();

    expect(log).toHaveBeenCalledWith('Sign-in instructions');
    expect(log).not.toHaveBeenCalledWith('Feature summary');
    expect(log).not.toHaveBeenCalledWith('Connecting to relay');
  });

  it('shows a duplicate-session prompt and buffers logs again after confirmation', async () => {
    const log = console.log;
    const warn = console.warn;
    connect.mockRejectedValueOnce(Object.assign(new Error('Already connected'), { code: 'client_id_in_use' }));
    vi.mocked(confirm).mockImplementationOnce(async () => {
      console.log('Take over this session?');
      return true;
    });
    await startProxyClient();

    expect(log).toHaveBeenCalledWith('Take over this session?');
    expect(warn).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith('Connecting to relay');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('shows startup failures and restores console output without opening the dashboard', async () => {
    const error = console.error;
    vi.mocked(loadConfig).mockImplementationOnce(() => { throw new Error('Unable to read config'); });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(startProxyClient()).rejects.toThrow('exit');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unable to read config'));
    expect(console.error).toBe(error);
    expect(Dashboard).not.toHaveBeenCalled();
  });

  it('prints buffered diagnostics when startup exits before reaching the dashboard', async () => {
    const exitListeners = new Set(process.listeners('exit'));
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(isDirectory).mockReturnValue(false);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      const onStartupExit = process.listeners('exit').find((listener) => !exitListeners.has(listener));
      onStartupExit?.(1);
      throw new Error('exit');
    });
    await expect(startProxyClient()).rejects.toThrow('exit');

    expect(write).toHaveBeenCalledWith(expect.stringContaining('Root directory not found'));
    expect(Dashboard).not.toHaveBeenCalled();
    expect(process.listenerCount('exit')).toBe(exitListeners.size);
  });
});
