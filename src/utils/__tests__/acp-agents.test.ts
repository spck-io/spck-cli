import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { pickWindowsCommand, resolveAcpAgents } from '../acp-agents.js';

vi.mock('child_process', () => ({ spawnSync: vi.fn() }));

const { packages } = vi.hoisted(() => ({
  packages: new Map<string, { bin: Record<string, string>; version: string }>(),
}));
vi.mock('module', () => ({
  createRequire: () => Object.assign(
    (jsonPath: string) => packages.get(jsonPath),
    { resolve: (specifier: string) => {
      const jsonPath = `/bundled/${specifier}`;
      if (!packages.has(jsonPath)) throw new Error('Package not installed');
      return jsonPath;
    } }
  ),
}));

// The bundled entry point is joined with the host's separators
const bundledBin = (pkg: string) => path.join('/bundled', pkg, 'dist', 'index.js');

describe('resolveAcpAgents', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(() => {
    packages.clear();
    packages.set('/bundled/@agentclientprotocol/claude-agent-acp/package.json', {
      bin: { 'claude-agent-acp': 'dist/index.js' }, version: '0.100.0',
    });
    packages.set('/bundled/@agentclientprotocol/codex-acp/package.json', {
      bin: { 'codex-acp': 'dist/index.js' }, version: '2.6.0',
    });
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as any);
    // The lookups below answer like `which`; the Windows test switches to `where`
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });
  afterEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(process, 'platform', platform);
  });

  it('resolves both bundled adapters without any global ACP executables', () => {
    expect(resolveAcpAgents()).toEqual([
      { name: 'claude', binary: process.execPath, args: [bundledBin('@agentclientprotocol/claude-agent-acp')], version: '0.100.0' },
      { name: 'codex', binary: process.execPath, args: [bundledBin('@agentclientprotocol/codex-acp')], version: '2.6.0' },
    ]);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('prefers bundled Codex over a global adapter and keeps Gemini on PATH', () => {
    vi.mocked(spawnSync).mockImplementation((_lookup, args) => ({
      status: 0, stdout: `/usr/local/bin/${(args as string[])[0]}\n`,
    }) as any);
    const agents = resolveAcpAgents();
    expect(agents.filter((agent) => agent.name === 'codex')).toEqual([
      { name: 'codex', binary: process.execPath, args: [bundledBin('@agentclientprotocol/codex-acp')], version: '2.6.0' },
    ]);
    expect(agents).toContainEqual({ name: 'gemini', binary: '/usr/local/bin/gemini', args: ['--acp'], version: '' });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith('which', ['gemini'], { encoding: 'utf8' });
  });

  it('falls back to a global Codex adapter if the package is missing', () => {
    packages.delete('/bundled/@agentclientprotocol/codex-acp/package.json');
    vi.mocked(spawnSync).mockImplementation((_lookup, args) => ({
      status: (args as string[])[0] === 'codex-acp' ? 0 : 1, stdout: '/usr/local/bin/codex-acp\n',
    }) as any);
    expect(resolveAcpAgents()).toContainEqual({ name: 'codex', binary: '/usr/local/bin/codex-acp', args: [], version: '' });
  });

  it('resolves Windows PATH agents from where output, running .cmd shims through cmd.exe', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(spawnSync).mockImplementation((_lookup, args) => ({
      status: (args as string[])[0] === 'gemini' ? 0 : 1,
      stdout: 'C:\\Users\\me\\AppData\\Roaming\\npm\\gemini\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd\r\n',
    }) as any);
    expect(resolveAcpAgents()).toContainEqual({
      name: 'gemini', binary: 'C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd', args: ['--acp'], version: '', shell: true,
    });
    expect(spawnSync).toHaveBeenCalledWith('where', ['gemini'], { encoding: 'utf8' });
  });

  it('omits missing adapter executables', () => {
    packages.clear();
    expect(resolveAcpAgents().map((agent) => agent.name)).not.toContain('codex');
    expect(resolveAcpAgents().map((agent) => agent.name)).not.toContain('gemini');
  });
});

describe('pickWindowsCommand', () => {
  it("skips npm's extensionless sh shim for the .cmd beside it", () => {
    expect(pickWindowsCommand('C:\\npm\\gemini\r\nC:\\npm\\gemini.cmd\r\n'))
      .toEqual({ binary: 'C:\\npm\\gemini.cmd', shell: true });
  });

  it('starts executables directly and keeps PATH order', () => {
    expect(pickWindowsCommand('C:\\tools\\gemini.EXE\r\nC:\\npm\\gemini.cmd\r\n'))
      .toEqual({ binary: 'C:\\tools\\gemini.EXE', shell: false });
  });

  it('returns null when nothing can be started', () => {
    expect(pickWindowsCommand('C:\\npm\\gemini\r\nC:\\npm\\gemini.ps1\r\n')).toBeNull();
    expect(pickWindowsCommand('')).toBeNull();
  });
});
