import { describe, it, expect, afterEach, vi } from 'vitest';
import { logAuth, logConnection, logFsRead, logSearchRead } from '../logger.js';
import { stripAnsi } from '../../dashboard/screen.js';

describe('logger console output', () => {
  afterEach(() => vi.restoreAllMocks());

  const spies = () => ({
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  });

  it('reports auth and connection problems as warnings and errors', () => {
    const { log, warn, error } = spies();
    logConnection('auth_failed', 'device-1');
    expect(error).toHaveBeenCalledOnce();
    logAuth('token_refresh_failed', {}, 'warn');
    expect(warn).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps routine events and failed file requests on the regular log', () => {
    const { log, warn, error } = spies();
    logConnection('ready', 'device-1');
    logFsRead('stat', { path: '/missing' }, 'device-1', false, new Error('ENOENT'));
    expect(log).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('prints a search once, with balanced quotes and without repeating metadata', () => {
    const { log } = spies();
    logSearchRead('search', { path: '/src', searchTerm: 'needle' }, 'device-1', true, undefined, { matches: 0, method: 'ripgrep' });
    const line = stripAnsi(String(log.mock.calls[0][0]));
    expect(line).toContain('"needle"');
    expect(line).toContain('matches=0');
    expect(line.match(/ripgrep/g)).toHaveLength(1);
  });
});
