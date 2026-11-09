import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveAcpAgents } from '../acp-agents.js';

vi.mock('../acp-agents.js', () => ({ resolveAcpAgents: vi.fn(() => []) }));

// Every tool is reported missing, as on a machine without git or ripgrep
vi.mock('child_process', () => ({
  exec: vi.fn((_command: string, ...args: any[]) => args.at(-1)(new Error('not found'))),
}));

import { detectTools } from '../tool-detection.js';

describe('detectTools', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps install hints for missing tools out of warnings', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const tools = await detectTools();

    expect(tools.git).toBe(false);
    expect(tools.ripgrep).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('BurntSushi/ripgrep');
    expect(log.mock.calls.flat().join('\n')).toContain('npm install -g @agentclientprotocol/codex-acp');
  });

  it('detects ACP executables even when --version fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(resolveAcpAgents).mockReturnValueOnce([
      { name: 'codex', binary: '/bin/codex-acp', args: [], version: '' },
      { name: 'gemini', binary: '/bin/gemini', args: ['--acp'], version: '' },
    ]);
    const tools = await detectTools();
    expect(tools.codex).toBe(true);
    expect(tools.gemini).toBe(true);
    expect(tools.claude).toBe(false);
  });
});
