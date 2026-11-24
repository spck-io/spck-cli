import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findWindowsProgram } from '../program-lookup.js';

describe('findWindowsProgram()', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck-lookup-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function install(folder: string, ...files: string[]): string {
    const bin = path.join(dir, folder);
    fs.mkdirSync(bin, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(bin, file), '');
    return bin;
  }

  it('tries every extension in one directory before the next', () => {
    const first = install('first', 'tool.cmd');
    const second = install('second', 'tool.exe');
    expect(findWindowsProgram('tool', ['.exe', '.cmd'], { PATH: [first, second].join(path.delimiter) }))
      .toBe(path.join(first, 'tool.cmd'));
  });

  it('uses the first extension found in a directory', () => {
    const bin = install('bin', 'tool.cmd', 'tool.exe');
    expect(findWindowsProgram('tool', ['.exe', '.cmd'], { Path: bin })).toBe(path.join(bin, 'tool.exe'));
  });

  it('reads quoted PATH entries', () => {
    const bin = install('Program Files', 'tool.exe');
    expect(findWindowsProgram('tool', ['.exe'], { PATH: `"${bin}"` })).toBe(path.join(bin, 'tool.exe'));
  });

  it('skips directories with the name and relative PATH entries', () => {
    install('bin', 'tool.exe');
    fs.writeFileSync(path.join(dir, 'tool.exe'), '');
    fs.mkdirSync(path.join(dir, 'folder', 'tool.exe'), { recursive: true });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(fs.existsSync(path.join('bin', 'tool.exe'))).toBe(true);
      expect(findWindowsProgram('tool', ['.exe'], { PATH: ['bin', '.', path.join(dir, 'folder')].join(path.delimiter) })).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it('returns null when nothing is found', () => {
    expect(findWindowsProgram('tool', ['.exe'], {})).toBeNull();
  });
});

describe('skipCurrentDirectoryInProgramSearch()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('turns the search off on Windows, and keeps the user setting for their shells', async () => {
    const lookup = await import('../program-lookup.js');
    const env: NodeJS.ProcessEnv = { PATH: 'x' };
    lookup.skipCurrentDirectoryInProgramSearch(env, 'win32');
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    expect(lookup.userShellEnv(env)).toEqual({ PATH: 'x' });
  });

  it('keeps a value the user set', async () => {
    const lookup = await import('../program-lookup.js');
    const env: NodeJS.ProcessEnv = { NoDefaultCurrentDirectoryInExePath: 'yes' };
    lookup.skipCurrentDirectoryInProgramSearch(env, 'win32');
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    expect(lookup.userShellEnv(env)).toEqual({ NoDefaultCurrentDirectoryInExePath: 'yes' });
  });

  it('changes nothing elsewhere', async () => {
    const lookup = await import('../program-lookup.js');
    const env: NodeJS.ProcessEnv = { PATH: 'x' };
    lookup.skipCurrentDirectoryInProgramSearch(env, 'linux');
    expect(env).toEqual({ PATH: 'x' });
    expect(lookup.userShellEnv({ PATH: 'y', NoDefaultCurrentDirectoryInExePath: '1' }))
      .toEqual({ PATH: 'y', NoDefaultCurrentDirectoryInExePath: '1' });
  });
});
