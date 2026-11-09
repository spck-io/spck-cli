import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SETTINGS, toggleSetting } from '../settings.js';
import { createDefaultConfig } from '../../config/config.js';
import { RPCRouter } from '../../rpc/router.js';
import { ErrorCode, ServerConfig } from '../../types.js';
import { saveConnectionPin } from '../pin-settings.js';
import * as configFile from '../../config/config.js';

const setting = (id: string) => SETTINGS.find(s => s.id === id)!;

describe('dashboard settings', () => {
  let dir: string;
  let configPath: string;
  let config: ServerConfig;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck-settings-'));
    configPath = path.join(dir, 'spck-cli.config.json');
    config = createDefaultConfig({ root: dir });
    fs.writeFileSync(configPath, JSON.stringify(config));
  });

  afterEach(() => {
    RPCRouter.setFeatureEnabled('terminal', true);
    RPCRouter.setCompactPrompt(true);
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readFile = (): ServerConfig => JSON.parse(fs.readFileSync(configPath, 'utf8'));

  it('defaults PIN protection off and enables it only with a locally configured PIN', () => {
    expect(setting('requirePin').get(config)).toBe(false);
    expect(() => toggleSetting(setting('requirePin'), config, configPath)).toThrow();
    saveConnectionPin(config, '012345', configPath);
    const stored = readFile();
    expect(stored.security.requirePin).toBe(true);
    expect(stored.security.pin?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('012345');
    expect(toggleSetting(setting('requirePin'), config, configPath)).toBe(false);
    expect(readFile().security.requirePin).toBe(false);
  });

  it('keeps protection unchanged if saving the new PIN fails', () => {
    vi.spyOn(configFile, 'updateConfigFile').mockImplementationOnce(() => { throw new Error('read-only'); });
    expect(() => saveConnectionPin(config, '1234', configPath)).toThrow('read-only');
    expect(config.security.requirePin).toBe(false);
    expect(config.security.pin).toBeUndefined();
  });

  it('defaults to compact prompts for older configs and saves dashboard changes for new terminals', () => {
    delete config.terminal.compactPrompt;
    const apply = vi.spyOn(RPCRouter, 'setCompactPrompt');
    expect(setting('compactPrompt').get(config)).toBe(true);
    expect(setting('compactPrompt').apply).toBe('newTerminals');
    expect(toggleSetting(setting('compactPrompt'), config, configPath)).toBe(false);
    expect(apply).toHaveBeenCalledWith(false);
    expect(readFile().terminal.compactPrompt).toBe(false);
    expect(toggleSetting(setting('compactPrompt'), config, configPath)).toBe(true);
    expect(readFile().terminal.compactPrompt).toBe(true);
  });

  it('turns the terminal off for the running CLI and saves it', async () => {
    expect(toggleSetting(setting('terminal'), config, configPath)).toBe(false);

    expect(config.terminal.enabled).toBe(false);
    expect(readFile().terminal.enabled).toBe(false);
    await expect(RPCRouter.route({ method: 'terminal.list', jsonrpc: '2.0' } as any, {} as any))
      .rejects.toMatchObject({ code: ErrorCode.FEATURE_DISABLED });
  });

  it('does not write in-memory CLI flag overrides back to the file', () => {
    config.languageServer = { enabled: false }; // as --no-language-server does

    toggleSetting(setting('userAuth'), config, configPath);

    const saved = readFile();
    expect(saved.security.userAuthenticationEnabled).toBe(true);
    expect(saved.languageServer).toBeUndefined();
  });

  it('round-trips optional sections that are missing from older configs', () => {
    delete config.fastLane;
    expect(setting('fastLane').get(config)).toBe(true);

    toggleSetting(setting('fastLane'), config, configPath);

    expect(readFile().fastLane).toEqual({ enabled: false });
  });
});
