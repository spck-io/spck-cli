import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveAcpAgents } from '../acp-agents.js';

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

  describe('on Windows', () => {
    let dir: string;
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck-agents-'));
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function install(folder: string, ...files: string[]): string {
      const bin = path.join(dir, folder);
      fs.mkdirSync(bin, { recursive: true });
      for (const file of files) fs.writeFileSync(path.join(bin, file), '');
      return bin;
    }

    // `where` printed this user's npm folder in the console's code page
    it("runs npm's .cmd shim through cmd.exe, in a user folder with non-ASCII characters", () => {
      const npm = install(path.join('José 张三', 'npm'), 'gemini', 'gemini.cmd');
      vi.stubEnv('PATH', [path.join(dir, 'empty'), npm].join(path.delimiter));
      expect(resolveAcpAgents()).toContainEqual({
        name: 'gemini', binary: path.join(npm, 'gemini.cmd'), args: ['--acp'], version: '', shell: true,
      });
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('starts executables directly and keeps PATH order', () => {
      const tools = install('tools', 'gemini.exe');
      const npm = install('npm', 'gemini.cmd');
      vi.stubEnv('PATH', [tools, npm].join(path.delimiter));
      expect(resolveAcpAgents()).toContainEqual({ name: 'gemini', binary: path.join(tools, 'gemini.exe'), args: ['--acp'], version: '' });
    });

    it('omits agents with nothing Windows can start', () => {
      vi.stubEnv('PATH', install('npm', 'gemini', 'gemini.ps1'));
      expect(resolveAcpAgents().map((agent) => agent.name)).not.toContain('gemini');
    });
  });

  it('omits missing adapter executables', () => {
    packages.clear();
    expect(resolveAcpAgents().map((agent) => agent.name)).not.toContain('codex');
    expect(resolveAcpAgents().map((agent) => agent.name)).not.toContain('gemini');
  });
});
