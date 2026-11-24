/**
 * Finding programs without looking in the current directory.
 *
 * Windows looks for a program in the current directory before PATH, both when
 * Node starts one by name and in cmd.exe. The current directory is usually the
 * project, which may not be trusted: a git.exe or git.bat in a cloned repository
 * would run in place of the real one.
 */

import * as fs from 'fs';
import * as path from 'path';

const SKIP_CURRENT_DIRECTORY = 'NoDefaultCurrentDirectoryInExePath';

let userSetting: { value: string | undefined } | null = null;

/**
 * Stop Windows looking in the current directory for programs this process
 * starts by name, and for the programs they start. Node's spawn and cmd.exe
 * both honor this variable.
 */
export function skipCurrentDirectoryInProgramSearch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32' || userSetting) return;
  userSetting = { value: env[SKIP_CURRENT_DIRECTORY] };
  env[SKIP_CURRENT_DIRECTORY] = '1';
}

/** A copy of `env` for the user's own shells, which search as the user set them up to */
export function userShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  if (!userSetting) return copy;
  // Copies of the Windows environment are case-sensitive
  for (const name of Object.keys(copy)) {
    if (name.toLowerCase() === SKIP_CURRENT_DIRECTORY.toLowerCase()) delete copy[name];
  }
  if (userSetting.value !== undefined) copy[SKIP_CURRENT_DIRECTORY] = userSetting.value;
  return copy;
}

function isProgram(file: string): boolean {
  try {
    return !fs.statSync(file).isDirectory();
  } catch {
    // App execution aliases, such as pwsh.exe from the Microsoft Store, can't
    // be stat'ed but do start
    try {
      fs.accessSync(file);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Find a Windows program in PATH: the first directory holding `name` with one
 * of `extensions`, tried in that order. Unlike `where`, it skips the current
 * directory and relative PATH entries, and returns non-ASCII paths intact
 * (`where` prints them in the console's code page).
 */
export function findWindowsProgram(
  name: string,
  extensions: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string | null {
  // Copies of the Windows environment keep its "Path" spelling
  for (const entry of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const dir = entry.replace(/"/g, '').trim();
    // A relative entry, such as ".", would search the current directory
    if (!path.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (isProgram(candidate)) return candidate;
    }
  }
  return null;
}
