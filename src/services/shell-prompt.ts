/** Shell-local prompt setup. Never changes the user's startup files. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ShellLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

const bashrc = `
if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
__spck_compact_prompt() {
  local previous_status=$?
  PS1='\\W \\$ '
  return "$previous_status"
}
# Keep existing prompt hooks, including arrays on newer Bash versions.
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
  PROMPT_COMMAND+=(__spck_compact_prompt)
else
  PROMPT_COMMAND="\${PROMPT_COMMAND:+\${PROMPT_COMMAND}$'\\n'}__spck_compact_prompt"
fi
__spck_compact_prompt
`;

// Route only startup through our temporary directory. Restore the user's
// ZDOTDIR before sourcing their files, including a ZDOTDIR set by .zshenv.
const zshenv = `
if [[ $SPCK_ORIGINAL_ZDOTDIR_SET == 1 ]]; then
  ZDOTDIR=$SPCK_ORIGINAL_ZDOTDIR
else
  unset ZDOTDIR
fi
[[ -r \${ZDOTDIR-$HOME}/.zshenv ]] && source "\${ZDOTDIR-$HOME}/.zshenv"
SPCK_USER_ZDOTDIR=\${ZDOTDIR-}
SPCK_USER_ZDOTDIR_SET=\${+ZDOTDIR}
ZDOTDIR=$SPCK_PROMPT_DIR
`;

const zshrc = `
if [[ $SPCK_USER_ZDOTDIR_SET == 1 ]]; then
  ZDOTDIR=$SPCK_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
unset SPCK_ORIGINAL_ZDOTDIR SPCK_ORIGINAL_ZDOTDIR_SET SPCK_USER_ZDOTDIR SPCK_USER_ZDOTDIR_SET SPCK_PROMPT_DIR
[[ -r \${ZDOTDIR-$HOME}/.zshrc ]] && source "\${ZDOTDIR-$HOME}/.zshrc"
__spck_compact_prompt() {
  local previous_status=$?
  PROMPT='%1~ %(!.#.$) '
  RPROMPT=''
  return $previous_status
}
precmd_functions+=(__spck_compact_prompt)
__spck_compact_prompt
`;

const fishInit = `
function fish_prompt
  set -l suffix '$'
  if test (id -u) -eq 0
    set suffix '#'
  end
  set -l folder (basename -- "$PWD")
  if test "$PWD" = "$HOME"
    set folder '~'
  end
  printf '%s %s ' "$folder" "$suffix"
end
function fish_right_prompt
end
`;

export function createShellLaunch(shell: string, compactPrompt: boolean, parentEnv = process.env): ShellLaunch {
  const launch: ShellLaunch = { args: [], env: { ...parentEnv }, cleanup() {} };
  if (!compactPrompt) return launch;
  const name = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase();
  if (name === 'fish') {
    launch.args = ['--init-command', fishInit];
  } else if (name === 'bash' || name === 'zsh') {
    const dir = mkdtempSync(join(tmpdir(), 'spck-prompt-'));
    launch.cleanup = () => rmSync(dir, { recursive: true, force: true });
    try {
      if (name === 'bash') {
        const file = join(dir, 'bashrc');
        writeFileSync(file, bashrc, { mode: 0o600 });
        launch.args = ['--rcfile', file];
      } else {
        writeFileSync(join(dir, '.zshenv'), zshenv, { mode: 0o600 });
        writeFileSync(join(dir, '.zshrc'), zshrc, { mode: 0o600 });
        launch.env.SPCK_PROMPT_DIR = dir;
        launch.env.SPCK_ORIGINAL_ZDOTDIR = parentEnv.ZDOTDIR ?? '';
        launch.env.SPCK_ORIGINAL_ZDOTDIR_SET = parentEnv.ZDOTDIR === undefined ? '0' : '1';
        launch.env.ZDOTDIR = dir;
      }
    } catch (error) {
      launch.cleanup();
      throw error;
    }
  }
  // Other shells retain their normal startup and prompt.
  return launch;
}
