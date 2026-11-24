import { afterEach, beforeEach, describe, expect, it } from 'vitest';
/**
 * Tests for AcpProcess with a real agent process
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcpProcess } from '../AcpProcess.js';

// A minimal ACP agent: answers every request with the arguments it was started with
const AGENT_JS = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { argv: process.argv.slice(2) } }) + '\\n');
  }
});
`;

describe('AcpProcess', () => {
  let dir: string;
  let proc: AcpProcess | null = null;

  beforeEach(() => {
    // A space in the path, like C:\Users\Jane Doe\AppData\Roaming\npm
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck acp agent '));
    fs.writeFileSync(path.join(dir, 'agent.js'), AGENT_JS);
  });

  afterEach(async () => {
    await proc?.stop();
    proc = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The kind of launcher npm installs for a global package: agent.cmd on Windows
  function writeLauncher(): string {
    const agentJs = path.join(dir, 'agent.js');
    if (process.platform === 'win32') {
      const launcher = path.join(dir, 'agent.cmd');
      fs.writeFileSync(launcher, `@"${process.execPath}" "${agentJs}" %*\r\n`);
      return launcher;
    }
    const launcher = path.join(dir, 'agent');
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${agentJs}" "$@"\n`, { mode: 0o755 });
    return launcher;
  }

  it('starts a launcher through the shell, quoting its path, and stops it', async () => {
    proc = new AcpProcess({ command: writeLauncher(), args: ['--acp'], cwd: dir, shell: true });
    proc.start();

    await expect(proc.request('initialize', {}, 10000)).resolves.toEqual({ argv: ['--acp'] });

    await proc.stop();
    expect(proc.isAlive()).toBe(false);
    // The agent is gone too, not just cmd.exe: Windows can't delete a running process's cwd
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts an executable directly with its arguments', async () => {
    proc = new AcpProcess({ command: process.execPath, args: [path.join(dir, 'agent.js'), 'a b'], cwd: dir });
    proc.start();

    await expect(proc.request('initialize', {}, 10000)).resolves.toEqual({ argv: ['a b'] });
  });
});
