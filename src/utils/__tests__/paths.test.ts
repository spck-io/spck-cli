import { afterEach, beforeEach, describe, expect, it } from 'vitest';
/**
 * Tests for editor <-> host path conversion, on POSIX and (via path.win32) Windows
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  hostPathKey,
  isMainModule,
  isPathInside,
  resolveClientPath,
  toClientPath,
  toRelativeClientPath,
  toRelativePosixPath,
} from '../paths.js';

const { posix, win32 } = path;

describe('paths', () => {
  describe('resolveClientPath', () => {
    it('resolves editor paths under the project root on Windows', () => {
      expect(resolveClientPath('C:\\proj', '/src/a.ts', win32)).toBe('C:\\proj\\src\\a.ts');
      expect(resolveClientPath('C:\\proj', '/', win32)).toBe('C:\\proj');
      expect(resolveClientPath('C:\\proj', '//src//a.ts', win32)).toBe('C:\\proj\\src\\a.ts');
      // Editors that saw a backslash path from an older CLI may send one back
      expect(resolveClientPath('C:\\proj', '\\src\\a.ts', win32)).toBe('C:\\proj\\src\\a.ts');
    });

    it('resolves editor paths under the project root on POSIX', () => {
      expect(resolveClientPath('/proj', '/src/a.ts', posix)).toBe('/proj/src/a.ts');
      expect(resolveClientPath('/proj', '/', posix)).toBe('/proj');
    });

    it('lets the root check catch Windows drive paths', () => {
      expect(isPathInside('C:\\proj', resolveClientPath('C:\\proj', 'C:/Windows/win.ini', win32), win32)).toBe(false);
      expect(isPathInside('C:\\proj', resolveClientPath('C:\\proj', '/C:/Windows/win.ini', win32), win32)).toBe(false);
      expect(isPathInside('C:\\proj', resolveClientPath('C:\\proj', 'D:\\secret', win32), win32)).toBe(false);
    });

    it('keeps UNC-looking paths inside the root', () => {
      expect(resolveClientPath('C:\\proj', '//server/share/x', win32)).toBe('C:\\proj\\server\\share\\x');
      expect(resolveClientPath('C:\\proj', '\\\\server\\share\\x', win32)).toBe('C:\\proj\\server\\share\\x');
    });
  });

  describe('toRelativeClientPath', () => {
    it('leaves ".." in place for the caller to reject when it climbs out', () => {
      expect(toRelativeClientPath('../../etc/passwd', posix)).toBe('../../etc/passwd');
      expect(toRelativeClientPath('..\\..\\Windows', win32)).toBe('../../Windows');
    });

    it('treats backslashes as file name characters on POSIX', () => {
      expect(toRelativeClientPath('/a\\b.txt', posix)).toBe('a\\b.txt');
    });
  });

  describe('isPathInside', () => {
    it('matches whole path segments, not string prefixes', () => {
      expect(isPathInside('/proj', '/proj', posix)).toBe(true);
      expect(isPathInside('/proj', '/proj/src/a.ts', posix)).toBe(true);
      expect(isPathInside('/proj', '/proj2/a.ts', posix)).toBe(false);
      expect(isPathInside('/proj', '/proj/..foo', posix)).toBe(true);
      expect(isPathInside('C:\\proj', 'C:\\proj2\\a.ts', win32)).toBe(false);
    });

    it('ignores case and separator style on Windows', () => {
      expect(isPathInside('C:\\Proj', 'c:\\proj\\src\\a.ts', win32)).toBe(true);
      expect(isPathInside('C:\\proj', 'C:/proj/src/a.ts', win32)).toBe(true);
      expect(isPathInside('C:\\proj', 'D:\\proj\\a.ts', win32)).toBe(false);
    });
  });

  describe('paths sent to the editor', () => {
    it('uses forward slashes on Windows', () => {
      expect(toRelativePosixPath('C:\\proj', 'C:\\proj\\src\\a.ts', win32)).toBe('src/a.ts');
      expect(toClientPath('C:\\proj', 'C:\\proj\\src\\a.ts', win32)).toBe('/src/a.ts');
      expect(toClientPath('C:\\proj', 'C:\\proj', win32)).toBe('/');
    });

    it('accepts the lowercase drive letters tsserver reports', () => {
      expect(toClientPath('C:\\proj', 'c:\\proj\\src\\a.ts', win32)).toBe('/src/a.ts');
    });

    it('keeps paths outside the root absolute', () => {
      expect(toClientPath('C:\\proj', 'C:\\Users\\me\\lib.d.ts', win32)).toBe('C:/Users/me/lib.d.ts');
      expect(toClientPath('/proj', '/usr/lib/lib.d.ts', posix)).toBe('/usr/lib/lib.d.ts');
    });

    it('is unchanged on POSIX, including backslashes in names', () => {
      expect(toClientPath('/proj', '/proj/src/a\\b.ts', posix)).toBe('/src/a\\b.ts');
      expect(toRelativePosixPath('/proj', '/proj/src/a.ts', posix)).toBe('src/a.ts');
    });
  });

  describe('hostPathKey', () => {
    it('ignores case on Windows only', () => {
      expect(hostPathKey('C:\\Proj\\A.ts', win32)).toBe(hostPathKey('c:\\proj\\a.ts', win32));
      expect(hostPathKey('/Proj/A.ts', posix)).not.toBe(hostPathKey('/proj/a.ts', posix));
    });
  });

  describe('isMainModule', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spck main module ')));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('matches the started script, even when its path needs percent-encoding', () => {
      const script = path.join(dir, 'index.js');
      fs.writeFileSync(script, '');
      expect(pathToFileURL(script).href).toContain('%20');
      expect(isMainModule(pathToFileURL(script).href, script)).toBe(true);
    });

    it('follows a symlinked script to the module', () => {
      const script = path.join(dir, 'index.js');
      const link = path.join(dir, 'spck');
      fs.writeFileSync(script, '');
      fs.symlinkSync(script, link);
      expect(isMainModule(pathToFileURL(script).href, link)).toBe(true);
    });

    it('rejects other scripts and a missing argv[1]', () => {
      const script = path.join(dir, 'index.js');
      const other = path.join(dir, 'other.js');
      fs.writeFileSync(script, '');
      fs.writeFileSync(other, '');
      expect(isMainModule(pathToFileURL(script).href, other)).toBe(false);
      expect(isMainModule(pathToFileURL(script).href, undefined)).toBe(false);
    });
  });
});
