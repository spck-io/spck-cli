import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
/**
 * Tests for project directory / config symlink setup
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) };
});

// Links left by an earlier run are the kind the CLI makes: junctions on Windows,
// where directory symlinks need admin rights or Developer Mode
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('project-dir', () => {
  let tempDir: string;
  let home: string;
  let projectRoot: string;
  let mod: typeof import('../project-dir.js');
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spck-project-dir-')));
    home = path.join(tempDir, 'home');
    projectRoot = path.join(tempDir, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(projectRoot);
    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mod = await import('../project-dir.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Back to the real symlinkSync
    vi.mocked(fs.symlinkSync).mockReset();
    restoreEnv('HOME', originalHome);
    restoreEnv('USERPROFILE', originalUserProfile);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the config symlink on a fresh project', () => {
    mod.ensureProjectDir(projectRoot);
    const link = mod.getConfigSymlinkPath(projectRoot);
    expect(path.resolve(fs.readlinkSync(link))).toBe(mod.getProjectDataPath(projectRoot));
    expect(mod.isProjectDirSetup(projectRoot)).toBe(true);
  });

  it('links the config with a junction on Windows, which needs no admin rights or Developer Mode', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      mod.ensureProjectDir(projectRoot);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(fs.symlinkSync).toHaveBeenLastCalledWith(
      mod.getProjectDataPath(projectRoot), mod.getConfigSymlinkPath(projectRoot), 'junction'
    );
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
    fs.symlinkSync(path.join(tempDir, 'old-home', '.spck-editor', 'projects', oldId), link, linkType);

    expect(mod.isProjectDirSetup(projectRoot)).toBe(false);
    expect(() => mod.ensureProjectDir(projectRoot)).not.toThrow();

    expect(path.resolve(fs.readlinkSync(link))).toBe(mod.getProjectDataPath(projectRoot));
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
    fs.symlinkSync(otherData, link, linkType);

    expect(mod.isProjectDirSetup(projectRoot)).toBe(false);
    mod.ensureProjectDir(projectRoot);

    expect(path.resolve(fs.readlinkSync(link))).toBe(dataPath);
    expect(fs.readFileSync(path.join(link, 'connection-settings.json'), 'utf8')).toBe('new');
  });

  // Windows can't create a junction on a network share
  const linkRefused = () => {
    throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
  };

  it('keeps config files in the home data directory when the link cannot be created', () => {
    vi.mocked(fs.symlinkSync).mockImplementation(linkRefused);

    expect(() => mod.ensureProjectDir(projectRoot)).not.toThrow();

    const dataPath = mod.getProjectDataPath(projectRoot);
    expect(fs.existsSync(mod.getConfigSymlinkPath(projectRoot))).toBe(false);
    expect(mod.getProjectFilePath(projectRoot, 'connection-settings.json')).toBe(path.join(dataPath, 'connection-settings.json'));
    expect(mod.getProjectFilePath(projectRoot, 'spck-cli.config.json')).toBe(path.join(dataPath, 'spck-cli.config.json'));
    expect(fs.existsSync(dataPath)).toBe(true);
    // Local files stay in the project
    expect(mod.getProjectFilePath(projectRoot, 'notes.json')).toBe(path.join(mod.getProjectDirPath(projectRoot), 'notes.json'));
    // And the next run tries again without failing
    expect(() => mod.ensureProjectDir(projectRoot)).not.toThrow();
  });

  it('keeps the config it migrated when relinking fails', () => {
    const otherData = path.join(home, '.spck-editor', 'projects', 'other');
    fs.mkdirSync(otherData, { recursive: true });
    fs.writeFileSync(path.join(otherData, 'connection-settings.json'), 'old');
    fs.mkdirSync(mod.getProjectDirPath(projectRoot));
    fs.symlinkSync(otherData, mod.getConfigSymlinkPath(projectRoot), linkType);
    vi.mocked(fs.symlinkSync).mockImplementation(linkRefused);

    expect(() => mod.ensureProjectDir(projectRoot)).not.toThrow();

    const settings = mod.getProjectFilePath(projectRoot, 'connection-settings.json');
    expect(settings).toBe(path.join(mod.getProjectDataPath(projectRoot), 'connection-settings.json'));
    expect(fs.readFileSync(settings, 'utf8')).toBe('old');
  });

  it('reads config files through the link when it exists', () => {
    mod.ensureProjectDir(projectRoot);
    expect(mod.getProjectFilePath(projectRoot, 'connection-settings.json'))
      .toBe(path.join(mod.getConfigSymlinkPath(projectRoot), 'connection-settings.json'));
  });
});
