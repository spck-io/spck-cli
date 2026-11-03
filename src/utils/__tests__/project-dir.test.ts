import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
/**
 * Tests for project directory / config symlink setup
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('project-dir', () => {
  let tempDir: string;
  let home: string;
  let projectRoot: string;
  let mod: typeof import('../project-dir.js');
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spck-project-dir-')));
    home = path.join(tempDir, 'home');
    projectRoot = path.join(tempDir, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(projectRoot);
    process.env.HOME = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mod = await import('../project-dir.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the config symlink on a fresh project', () => {
    mod.ensureProjectDir(projectRoot);
    const link = mod.getConfigSymlinkPath(projectRoot);
    expect(fs.readlinkSync(link)).toBe(mod.getProjectDataPath(projectRoot));
    expect(mod.isProjectDirSetup(projectRoot)).toBe(true);
  });

  it('repairs a dangling symlink from a renamed home dir and migrates its config', () => {
    // Old config lives under the same project ID in the current home, but the link
    // still points at the old (now nonexistent) home path
    const oldId = 'a46bb85160d10119';
    const oldData = path.join(home, '.spck-editor', 'projects', oldId);
    fs.mkdirSync(oldData, { recursive: true });
    fs.writeFileSync(path.join(oldData, 'connection-settings.json'), '{"ok":true}');

    const projectDir = mod.getProjectDirPath(projectRoot);
    fs.mkdirSync(projectDir);
    const link = mod.getConfigSymlinkPath(projectRoot);
    fs.symlinkSync(path.join(tempDir, 'old-home', '.spck-editor', 'projects', oldId), link, 'dir');

    expect(mod.isProjectDirSetup(projectRoot)).toBe(false);
    expect(() => mod.ensureProjectDir(projectRoot)).not.toThrow();

    expect(fs.readlinkSync(link)).toBe(mod.getProjectDataPath(projectRoot));
    expect(fs.readFileSync(path.join(link, 'connection-settings.json'), 'utf8')).toBe('{"ok":true}');
    expect(mod.isProjectDirSetup(projectRoot)).toBe(true);
  });

  it('relinks a symlink pointing at another existing project without clobbering new data', () => {
    const otherData = path.join(home, '.spck-editor', 'projects', 'other');
    fs.mkdirSync(otherData, { recursive: true });
    fs.writeFileSync(path.join(otherData, 'connection-settings.json'), 'old');

    const dataPath = mod.getProjectDataPath(projectRoot);
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, 'connection-settings.json'), 'new');

    fs.mkdirSync(mod.getProjectDirPath(projectRoot));
    const link = mod.getConfigSymlinkPath(projectRoot);
    fs.symlinkSync(otherData, link, 'dir');

    expect(mod.isProjectDirSetup(projectRoot)).toBe(false);
    mod.ensureProjectDir(projectRoot);

    expect(fs.readlinkSync(link)).toBe(dataPath);
    expect(fs.readFileSync(path.join(link, 'connection-settings.json'), 'utf8')).toBe('new');
  });
});
