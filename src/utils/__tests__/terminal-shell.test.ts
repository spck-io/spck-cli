import { afterEach, beforeEach, describe, expect, it } from 'vitest';
/**
 * Tests for choosing the terminal shell
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import defaultShell from 'default-shell';
import { getTerminalShell } from '../terminal-shell.js';

describe('getTerminalShell', () => {
  let dir: string;
  let systemRoot: string;
  let windowsPowerShell: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck-shell-'));
    systemRoot = path.join(dir, 'Windows');
    windowsPowerShell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function touch(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  }

  it('uses the login shell outside Windows', () => {
    expect(getTerminalShell({ COMSPEC: 'cmd.exe' }, 'linux')).toBe(defaultShell);
    expect(getTerminalShell({ COMSPEC: 'cmd.exe' }, 'darwin')).toBe(defaultShell);
  });

  it('prefers PowerShell 7 on PATH over Windows PowerShell', () => {
    touch(windowsPowerShell);
    const pwsh = touch(path.join(dir, 'PowerShell', '7', 'pwsh.exe'));
    const env = { Path: [path.join(dir, 'empty'), path.dirname(pwsh)].join(path.delimiter), SystemRoot: systemRoot, ComSpec: 'cmd.exe' };
    expect(getTerminalShell(env, 'win32')).toBe(pwsh);
  });

  it('falls back to Windows PowerShell, then cmd.exe', () => {
    const env = { PATH: path.join(dir, 'empty'), SystemRoot: systemRoot, ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    expect(getTerminalShell(env, 'win32')).toBe('C:\\Windows\\system32\\cmd.exe');
    touch(windowsPowerShell);
    expect(getTerminalShell(env, 'win32')).toBe(windowsPowerShell);
  });
});
