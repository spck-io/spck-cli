import { describe, it, expect, vi, afterEach } from 'vitest';

// Every tool is reported missing, as on a machine without git or ripgrep
vi.mock('child_process', () => ({
  exec: vi.fn((_command: string, callback: (error: Error) => void) => callback(new Error('not found'))),
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
  });
});
