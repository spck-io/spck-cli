/**
 * Converting between the editor's paths and the host's.
 *
 * The editor always speaks POSIX paths rooted at the project ("/src/a.ts").
 * On Windows, path.normalize turns that into "\src\a.ts", which path.resolve
 * treats as the root of the current drive, and path.relative returns
 * backslashes the editor can't use. Every conversion goes through here.
 *
 * The conversions take the path module as their last argument so tests can
 * check the Windows behaviour with path.win32 on any host.
 */

import * as fs from 'fs';
import * as nodePath from 'path';
import { fileURLToPath } from 'url';

type PathModule = nodePath.PlatformPath;

function isWindowsPaths(p: PathModule): boolean {
  return p.sep === '\\';
}

/**
 * Normalize an editor path to a POSIX path relative to the project root,
 * without leading slashes ("/src/../a.ts" -> "a.ts"). On Windows, backslashes
 * count as separators too; on POSIX they are ordinary file name characters.
 */
export function toRelativeClientPath(clientPath: string, p: PathModule = nodePath): string {
  const slashed = isWindowsPaths(p) ? clientPath.replace(/\\/g, '/') : clientPath;
  return nodePath.posix.normalize(slashed).replace(/^\/+/, '');
}

/** Resolve an editor path ("/src/a.ts") to an absolute host path under root. */
export function resolveClientPath(root: string, clientPath: string, p: PathModule = nodePath): string {
  return p.resolve(root, toRelativeClientPath(clientPath, p));
}

/**
 * Whether target is root itself or inside it. Compares whole path segments,
 * so a root of /proj doesn't contain /proj2, and ignores case on Windows.
 */
export function isPathInside(root: string, target: string, p: PathModule = nodePath): boolean {
  const relative = p.relative(root, target);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith('..' + p.sep) && !p.isAbsolute(relative);
}

/**
 * Where a host path really leads, with its links (symlinks, Windows
 * junctions) followed. A path that doesn't exist yet leads wherever the
 * links in its existing folders and any dangling link on the way point, as
 * a new file is created through them. Returns null for links in a loop.
 */
export async function resolveLinks(target: string): Promise<string | null> {
  const missing: string[] = [];
  let current = nodePath.resolve(target);
  let links = 0;
  for (;;) {
    try {
      return nodePath.join(await fs.promises.realpath(current), ...missing);
    } catch {
      // A link realpath couldn't follow, as its target is missing
      const link = await fs.promises.readlink(current).catch(() => null);
      if (link !== null) {
        if (++links > 40) return null;
        // A relative target starts from the folder the link is really in
        const folder = nodePath.dirname(current);
        current = nodePath.resolve(await fs.promises.realpath(folder).catch(() => folder), link);
        continue;
      }
      const parent = nodePath.dirname(current);
      if (parent === current) return nodePath.join(current, ...missing);
      missing.unshift(nodePath.basename(current));
      current = parent;
    }
  }
}

/** Whether a host path's links (see resolveLinks) keep it inside realRoot, a realpath. */
export async function linksStayInside(realRoot: string, target: string): Promise<boolean> {
  const leadsTo = await resolveLinks(target);
  return leadsTo !== null && isPathInside(realRoot, leadsTo);
}

/** Replace the host's separators with forward slashes (a no-op on POSIX). */
export function toPosixPath(hostPath: string, p: PathModule = nodePath): string {
  return isWindowsPaths(p) ? hostPath.replace(/\\/g, '/') : hostPath;
}

/** Path of target relative to root with forward slashes: "src/a.ts", or "" for root. */
export function toRelativePosixPath(root: string, target: string, p: PathModule = nodePath): string {
  return toPosixPath(p.relative(root, target), p);
}

/**
 * Editor path for a host path: "/src/a.ts" when it is inside root, otherwise
 * the absolute host path with forward slashes ("C:/Users/me/lib.d.ts").
 */
export function toClientPath(root: string, target: string, p: PathModule = nodePath): string {
  if (isPathInside(root, target, p)) return '/' + toRelativePosixPath(root, target, p);
  return toPosixPath(target, p);
}

/**
 * A map key for a host path. Windows file systems ignore case, and tools
 * disagree about it (tsserver reports "c:\..." for a "C:\..." root).
 */
export function hostPathKey(hostPath: string, p: PathModule = nodePath): string {
  const resolved = p.resolve(hostPath);
  return isWindowsPaths(p) ? resolved.toLowerCase() : resolved;
}

/**
 * Whether a module (its import.meta.url) is the script Node was started with
 * (process.argv[1]). Comparing against `file://${argv[1]}` never matches on
 * Windows ("file:///C:/..." vs "C:\...") or for paths that need
 * percent-encoding, such as ones with spaces.
 */
export function isMainModule(moduleUrl: string, scriptPath: string | undefined): boolean {
  if (!scriptPath) return false;
  try {
    return hostPathKey(fs.realpathSync(fileURLToPath(moduleUrl))) === hostPathKey(fs.realpathSync(scriptPath));
  } catch {
    return false;
  }
}
