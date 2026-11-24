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
  linksStayInside,
  resolveClientPath,
  resolveLinks,
  toClientPath,
  toRelativeClientPath,
  toRelativePosixPath,
} from '../paths.js';

const { posix, win32 } = path;

// Windows only lets administrators or Developer Mode create symlinks
function canSymlink(): boolean {
  if (process.platform !== 'win32') return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck-symlink-probe-'));
  try {
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'));
    return true;
  } catch (error: any) {
    if (error.code === 'EPERM') return false;
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

    it.runIf(canSymlink())('follows a symlinked script to the module', () => {
      const script = path.join(dir, 'index.js');
      const link = path.join(dir, 'spck');
      fs.writeFileSync(script, '');
      fs.symlinkSync(script, link);
      expect(isMainModule(pathToFileURL(script).href, link)).toBe(true);
    });

    // npm link on Windows joins the package in with a junction, which needs no
    // privileges. argv[1] keeps the junction path; import.meta.url is the real one.
    it('follows a script in a junctioned directory to the module', () => {
      const pkg = path.join(dir, 'pkg');
      const link = path.join(dir, 'linked');
      fs.mkdirSync(pkg);
      fs.writeFileSync(path.join(pkg, 'index.js'), '');
      fs.symlinkSync(pkg, link, 'junction');
      expect(isMainModule(pathToFileURL(path.join(pkg, 'index.js')).href, path.join(link, 'index.js'))).toBe(true);
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

  // Junctions need no privileges on Windows (a plain directory symlink elsewhere)
  describe('resolveLinks', () => {
    let dir: string;
    let project: string;
    let outside: string;

    beforeEach(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spck-links-')));
      project = path.join(dir, 'project');
      outside = path.join(dir, 'outside');
      fs.mkdirSync(project);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.txt'), '');
      fs.symlinkSync(outside, path.join(project, 'link'), 'junction');
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('follows the links to an existing path', async () => {
      expect(await resolveLinks(path.join(project, 'link', 'secret.txt'))).toBe(path.join(outside, 'secret.txt'));
      expect(await resolveLinks(project)).toBe(project);
    });

    it('follows the links in the folders of a path that does not exist yet', async () => {
      expect(await resolveLinks(path.join(project, 'link', 'a', 'b.txt'))).toBe(path.join(outside, 'a', 'b.txt'));
      expect(await resolveLinks(path.join(project, 'new', 'b.txt'))).toBe(path.join(project, 'new', 'b.txt'));
    });

    it('follows a dangling link to where it points', async () => {
      const gone = path.join(dir, 'gone');
      fs.mkdirSync(gone);
      fs.symlinkSync(gone, path.join(project, 'dangling'), 'junction');
      fs.rmdirSync(gone);
      expect(await resolveLinks(path.join(project, 'dangling'))).toBe(gone);
      expect(await resolveLinks(path.join(project, 'dangling', 'sub', 'c.txt'))).toBe(path.join(gone, 'sub', 'c.txt'));
    });

    it('gives up on links in a loop', async () => {
      const a = path.join(project, 'a');
      const b = path.join(project, 'b');
      fs.symlinkSync(b, a, 'junction');
      fs.symlinkSync(a, b, 'junction');
      expect(await resolveLinks(path.join(a, 'x.txt'))).toBeNull();
      expect(await linksStayInside(project, path.join(a, 'x.txt'))).toBe(false);
    });

    it('tells whether the links keep a path inside a folder', async () => {
      expect(await linksStayInside(project, path.join(project, 'new.txt'))).toBe(true);
      expect(await linksStayInside(project, path.join(project, 'link', 'new.txt'))).toBe(false);
    });
  });
});
