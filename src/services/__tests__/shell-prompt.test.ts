import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShellLaunch, type ShellLaunch } from '../shell-prompt.js';

const hasPwsh = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { timeout: 20000 }).status === 0;

describe('compact shell prompts', () => {
  let home: string;
  let folder: string;
  const launches: ShellLaunch[] = [];
  const marker = process.geteuid?.() === 0 ? '#' : '$';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'spck-prompt-test-'));
    folder = join(home, 'project folder');
    mkdirSync(folder);
  });

  afterEach(() => {
    for (const launch of launches.splice(0)) launch.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  function launch(shell: string, enabled = true, env: NodeJS.ProcessEnv = {}) {
    const config = createShellLaunch(shell, enabled, { ...process.env, HOME: home, ZDOTDIR: undefined, BASH_SILENCE_DEPRECATION_WARNING: '1', ...env });
    launches.push(config);
    return config;
  }

  function run(shell: string, config: ShellLaunch, input: string) {
    // ZLE reads from the controlling terminal even when stdin is piped.
    const interactiveArgs = shell === '/bin/zsh' ? ['-i', '+Z'] : ['-i'];
    const result = spawnSync(shell, [...config.args, ...interactiveArgs], {
      env: config.env, cwd: folder, input, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return result;
  }

  it.each(['bash', 'zsh', 'fish', 'cmd.exe', 'pwsh.exe'])('leaves %s untouched when disabled', (shell) => {
    const config = launch(shell, false);
    expect(config.args).toEqual([]);
    expect(config.env.ZDOTDIR).toBeUndefined();
    expect(config.env.PS1).toBe(process.env.PS1);
  });

  it('does not change unknown shells or the parent environment', () => {
    const env = { HOME: home, ZDOTDIR: '/original' };
    const config = createShellLaunch('/bin/unknown-shell', true, env);
    expect(config.args).toEqual([]);
    expect(config.env).toEqual(env);
    expect(config.env).not.toBe(env);
  });

  it.each(['pwsh', 'pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell.exe'])(
    'starts %s with the compact prompt after its profile', (shell) => {
      const { args } = launch(shell);
      expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
      // The Windows command line would need unescaped double quotes escaped
      expect(args[3]).not.toContain('"');
    }
  );

  describe.skipIf(!hasPwsh)('PowerShell', () => {
    it('shows the folder name, ~ at home, or the path of a drive with no folders', () => {
      const { args } = launch('pwsh');
      // Strict mode, as some profiles set, turns sloppy prompt code into errors
      const script = `Set-StrictMode -Version Latest; ${args[3]}; Set-Location -LiteralPath '${folder}'; prompt; ` +
        'Set-Location -LiteralPath $HOME; prompt; Set-Location Env:; prompt';
      const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', script], {
        env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
      });
      expect(result.stderr).toBe('');
      const envPath = process.platform === 'win32' ? 'Env:\\' : 'Env:/';
      expect(result.stdout.split(/\r?\n/)).toEqual(['project folder> ', '~> ', `${envPath}> `, '']);
    });

    // A profile in a temporary home; XDG paths keep history and caches there too
    function writeProfile() {
      const dir = join(home, '.config', 'powershell');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'Microsoft.PowerShell_profile.ps1'),
        "$env:SPCK_TEST_STARTUP = 'loaded'\nfunction spck_test_fn { 'profile-ok' }\nfunction prompt { 'user@computer> ' }\n");
      return {
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_CACHE_HOME: join(home, '.cache'),
        POWERSHELL_TELEMETRY_OPTOUT: '1',
        POWERSHELL_UPDATECHECK: 'Off',
      };
    }

    // Starts PowerShell the way TerminalService does, in a real PTY. A headless
    // xterm stands in for the editor's terminal: it answers PSReadLine's cursor
    // position queries and gives the screen as the user would see it.
    async function runInTerminal(config: ShellLaunch, steps: Array<[input: string, waitFor: RegExp]>): Promise<string> {
      const pty = await import('node-pty');
      const { Terminal } = (await import('@xterm/headless')).default as any;
      const term = new Terminal({ cols: 120, rows: 60, allowProposedApi: true });
      const env = Object.fromEntries(Object.entries(config.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
      const proc = pty.spawn('pwsh', config.args, { name: 'xterm-256color', cols: 120, rows: 60, cwd: folder, env });
      const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));
      term.onData((data: string) => proc.write(data));
      proc.onData((data) => term.write(data));
      // Lines as drawn; the space after a prompt is drawn too, so it stays
      const screen = () => {
        const lines: string[] = [];
        for (let i = 0; i < term.buffer.active.length; i++) {
          lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '');
        }
        return lines.join('\n');
      };
      try {
        for (const [input, pattern] of steps) {
          if (input) proc.write(input + '\r');
          const deadline = Date.now() + 15000;
          while (!pattern.test(screen())) {
            if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern} in:\n${screen()}`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        proc.write('exit\r');
        await exited;
        return screen();
      } finally {
        try { proc.kill(); } catch { /* already exited */ }
        term.dispose();
      }
    }

    it.skipIf(process.platform === 'win32')('keeps the profile, exit codes and line editing in a real terminal', async () => {
      const text = await runInTerminal(launch('pwsh', true, writeProfile()), [
        ['', /^project folder> $/m],
        ["sh -c 'exit 3'", /^project folder> sh -c 'exit 3'\nproject folder> $/m],
        ['"state:${LASTEXITCODE}:$env:SPCK_TEST_STARTUP"', /^state:/m],
        ['spck_test_fn', /^profile-ok$/m],
        ['"psreadline:$([bool](Get-Module PSReadLine))"', /^psreadline:/m],
        ['cd /', /^\/> $/m],
        ['cd ~', /^~> $/m],
      ]);
      expect(text).toMatch(/^state:3:loaded$/m);
      expect(text).toMatch(/^psreadline:True$/m);
      expect(text).not.toContain('user@computer>');
      expect(text).not.toMatch(/PowerShell \d/);
    }, 60000);

    it.skipIf(process.platform === 'win32')('uses the profile prompt and banner when disabled', async () => {
      const text = await runInTerminal(launch('pwsh', false, writeProfile()), [['', /^user@computer> $/m]]);
      expect(text).toMatch(/PowerShell \d/);
    }, 60000);
  });

  describe.skipIf(!existsSync('/bin/bash'))('Bash', () => {
    it('loads aliases, preserves prompt hooks and exit status, and follows directory changes', () => {
      const rc = `export SPCK_TEST_STARTUP=loaded
alias spck_test_alias='printf alias-ok'
PS1='user@computer: '
PS2='continuation> '
PROMPT_COMMAND='printf "hook-status:%s\\n" "$?"; PS1="user@computer: "'
`;
      writeFileSync(join(home, '.bashrc'), rc);
      const result = run('/bin/bash', launch('/bin/bash'),
        'false\nprintf "state:%s:%s:%s\\n" "$?" "$SPCK_TEST_STARTUP" "$PS2"\nspck_test_alias\ncd /\nexit\n');
      expect(result.stderr).toContain(`project folder ${marker} `);
      expect(result.stderr).toContain(`/ ${marker} `);
      expect(result.stderr).not.toContain('user@computer:');
      expect(result.stdout).toContain('hook-status:1');
      expect(result.stdout).toContain('state:1:loaded:continuation> ');
      expect(result.stdout).toContain('alias-ok');
      expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe(rc);
    });

    it('uses the original prompt when disabled', () => {
      writeFileSync(join(home, '.bashrc'), 'PS1="original-computer> "\n');
      expect(run('/bin/bash', launch('/bin/bash', false), 'exit\n').stderr).toContain('original-computer> ');
    });

    it('removes temporary files when disposed', () => {
      const config = launch('/bin/bash');
      const file = config.args[1];
      expect(existsSync(file)).toBe(true);
      config.cleanup();
      expect(existsSync(file)).toBe(false);
    });
  });

  describe.skipIf(!existsSync('/bin/zsh'))('Zsh', () => {
    it.each([false, true])('loads the user startup files with custom ZDOTDIR=%s', (custom) => {
      const dotdir = custom ? join(home, 'dot files') : home;
      if (custom) mkdirSync(dotdir);
      writeFileSync(join(dotdir, '.zshenv'), 'export SPCK_TEST_ENV=loaded\n');
      const rc = `alias spck_test_alias='printf alias-ok'
PS2='continuation> '
precmd() { printf 'hook-status:%s\\n' "$?"; PROMPT='user@computer: '; }
`;
      writeFileSync(join(dotdir, '.zshrc'), rc);
      const config = launch('/bin/zsh', true, { ZDOTDIR: custom ? dotdir : undefined });
      const result = run('/bin/zsh', config,
        'false\nprintf "state:%s:%s:%s:%s\\n" "$?" "$SPCK_TEST_ENV" "$PS2" "${ZDOTDIR-unset}"\nspck_test_alias\ncd /\nexit\n');
      expect(result.stderr).toContain(`project folder ${marker} `);
      expect(result.stderr).toContain(`/ ${marker} `);
      expect(result.stderr).not.toContain('user@computer:');
      expect(result.stdout).toContain('hook-status:1');
      expect(result.stdout).toContain(`state:1:loaded:continuation> :${custom ? dotdir : 'unset'}`);
      expect(result.stdout).toContain('alias-ok');
      expect(readFileSync(join(dotdir, '.zshrc'), 'utf8')).toBe(rc);
    });

    it('honors a ZDOTDIR redirected by the user’s .zshenv', () => {
      const dotdir = join(home, 'custom');
      mkdirSync(dotdir);
      writeFileSync(join(home, '.zshenv'), 'ZDOTDIR="$HOME/custom"\n');
      writeFileSync(join(dotdir, '.zshrc'), 'export SPCK_TEST_REDIRECT=loaded\n');
      const result = run('/bin/zsh', launch('/bin/zsh'), 'print -r -- "$SPCK_TEST_REDIRECT:$ZDOTDIR"\nexit\n');
      expect(result.stdout).toContain(`loaded:${dotdir}`);
      expect(result.stderr).toContain(`project folder ${marker} `);
    });
  });
});
