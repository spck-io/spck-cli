import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShellLaunch, type ShellLaunch } from '../shell-prompt.js';

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

  it.each(['bash', 'zsh', 'fish', 'cmd.exe'])('leaves %s untouched when disabled', (shell) => {
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
