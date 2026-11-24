/**
 * Shell for new terminals.
 */

import * as fs from 'fs';
import * as path from 'path';
import defaultShell from 'default-shell';

function findOnPath(file: string, env: NodeJS.ProcessEnv): string | null {
  // Copies of the Windows environment keep its "Path" spelling
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The user's login shell on macOS and Linux. On Windows, where that would be
 * cmd.exe, prefer PowerShell 7 (pwsh) when installed, then the Windows
 * PowerShell every Windows version has, then cmd.exe.
 */
export function getTerminalShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return defaultShell;
  const windowsPowerShell = path.join(
    env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  return findOnPath('pwsh.exe', env)
    ?? (fs.existsSync(windowsPowerShell) ? windowsPowerShell : null)
    ?? env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
}
