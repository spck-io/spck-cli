import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { resolveAcpAgents } from '../acp-agents.js';

vi.mock('child_process', () => ({ spawnSync: vi.fn() }));

describe('resolveAcpAgents', () => {
  afterEach(() => vi.resetAllMocks());

  it('resolves ACP adapter executables without invoking --version', () => {
    vi.mocked(spawnSync).mockImplementation((_lookup, args) => ({
      status: 0, stdout: `/usr/local/bin/${(args as string[])[0]}\n`,
    }) as any);
    expect(resolveAcpAgents()).toEqual(expect.arrayContaining([
      { name: 'codex', binary: '/usr/local/bin/codex-acp', args: [], version: '' },
      { name: 'gemini', binary: '/usr/local/bin/gemini', args: ['--acp'], version: '' },
    ]));
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'where' : 'which', ['codex-acp'], { encoding: 'utf8' }
    );
  });

  it('omits missing adapter executables', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as any);
    expect(resolveAcpAgents().map((agent) => agent.name)).not.toContain('codex');
    expect(resolveAcpAgents().map((agent) => agent.name)).not.toContain('gemini');
  });
});
