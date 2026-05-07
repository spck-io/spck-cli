// Resolve an npm package's bin script to a { command, args } pair that
// invokes it through the current Node.js binary rather than relying on a
// global PATH entry.  Falls back to the bare name (PATH lookup) if resolution
// fails so the caller degrades gracefully.

import * as path from 'path';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

export function resolveLocalBin(
  packageName: string,
  binName: string,
): { command: string; args: string[] } {
  try {
    // Resolve the package's package.json to find the bin field.
    const pkgJsonPath = _require.resolve(`${packageName}/package.json`);
    const pkgJson = _require(`${packageName}/package.json`) as {
      bin?: string | Record<string, string>;
    };
    const binField = pkgJson.bin;
    const binScript =
      typeof binField === 'string' ? binField : binField?.[binName];
    if (binScript) {
      const pkgDir = path.dirname(pkgJsonPath);
      const scriptPath = path.resolve(pkgDir, binScript);
      return { command: process.execPath, args: [scriptPath] };
    }
  } catch {
    // Package not found or missing bin — fall through to PATH.
  }
  return { command: binName, args: [] };
}
