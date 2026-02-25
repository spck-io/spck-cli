/**
 * Project directory management with symlink support
 * .spck-editor/ is a regular directory with .spck-editor/config symlinked to ~/.spck-editor/projects/{id}
 * This prevents accidental git commits of secrets while avoiding cross-device link errors
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { t } from '../i18n/index.js';

const PROJECT_DIR_NAME = '.spck-editor';
const CONFIG_SUBDIR_NAME = 'config';

/**
 * Get the home base directory for projects
 * Called at runtime instead of module load time to avoid issues in test environments
 */
function getHomeBaseDir(): string {
  return path.join(os.homedir(), '.spck-editor', 'projects');
}

/**
 * Generate a consistent project ID from the project root path
 */
export function generateProjectId(projectRoot: string): string {
  // Resolve to absolute path and normalize
  const absolutePath = path.resolve(projectRoot);

  // Generate SHA256 hash of the absolute path
  const hash = crypto.createHash('sha256').update(absolutePath).digest('hex');

  // Use first 16 characters for readability (still unique enough)
  return hash.substring(0, 16);
}

/**
 * Get the home directory location for a project's data
 */
export function getProjectDataPath(projectRoot: string): string {
  const projectId = generateProjectId(projectRoot);
  return path.join(getHomeBaseDir(), projectId);
}

/**
 * Get the .spck-editor directory path in the project
 */
export function getProjectDirPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DIR_NAME);
}

/**
 * Get the config symlink path (.spck-editor/config)
 */
export function getConfigSymlinkPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DIR_NAME, CONFIG_SUBDIR_NAME);
}

/**
 * @deprecated Use getConfigSymlinkPath() instead
 * Legacy compatibility - returns config symlink path
 */
export function getProjectSymlinkPath(projectRoot: string): string {
  return getConfigSymlinkPath(projectRoot);
}

/**
 * Check if the project directory exists and is properly set up
 */
export function isProjectDirSetup(projectRoot: string): boolean {
  const projectDir = getProjectDirPath(projectRoot);
  const configSymlink = getConfigSymlinkPath(projectRoot);
  const dataPath = getProjectDataPath(projectRoot);

  // Check if .spck-editor directory exists
  if (!fs.existsSync(projectDir)) {
    return false;
  }

  // Check if .spck-editor is a directory (not old-style symlink)
  try {
    const stats = fs.lstatSync(projectDir);
    if (stats.isSymbolicLink()) {
      // Old structure - needs migration
      return false;
    }
    if (!stats.isDirectory()) {
      return false;
    }
  } catch (error) {
    return false;
  }

  // Check if config symlink exists
  if (!fs.existsSync(configSymlink)) {
    return false;
  }

  // Check if config is a symlink
  try {
    const stats = fs.lstatSync(configSymlink);
    if (!stats.isSymbolicLink()) {
      return false;
    }
  } catch (error) {
    return false;
  }

  // Check if data directory exists
  if (!fs.existsSync(dataPath)) {
    return false;
  }

  return true;
}

/**
 * Setup the project directory with config symlink
 * Creates ~/.spck-editor/projects/{project_id}/ and symlinks .spck-editor/config to it
 */
export function setupProjectDir(projectRoot: string): void {
  const projectDir = getProjectDirPath(projectRoot);
  const configSymlink = getConfigSymlinkPath(projectRoot);
  const dataPath = getProjectDataPath(projectRoot);
  const homeBaseDir = getHomeBaseDir();

  // Ensure home base directory exists
  if (!fs.existsSync(homeBaseDir)) {
    fs.mkdirSync(homeBaseDir, { recursive: true, mode: 0o700 });
  }

  // Ensure project data directory exists
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  }

  // Create .spck-editor directory if it doesn't exist
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { mode: 0o700 });
  }

  // Create subdirectories (.tmp, .trash, logs)
  const subdirs = ['.tmp', '.trash', 'logs'];
  for (const subdir of subdirs) {
    const subdirPath = path.join(projectDir, subdir);
    if (!fs.existsSync(subdirPath)) {
      fs.mkdirSync(subdirPath, { mode: 0o700 });
    }
  }

  // Create config symlink if it doesn't exist
  if (!fs.existsSync(configSymlink)) {
    fs.symlinkSync(dataPath, configSymlink, 'dir');
  } else {
    // Verify existing symlink points to correct location
    const stats = fs.lstatSync(configSymlink);
    if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(configSymlink);
      if (target !== dataPath) {
        // Points to wrong location - remove and recreate
        fs.unlinkSync(configSymlink);
        fs.symlinkSync(dataPath, configSymlink, 'dir');
      }
    }
  }

  console.log(`✅ ${t('projectDir.configured')}`);
  console.log(`   ${t('projectDir.directory', { path: projectDir })}`);
  console.log(`   ${t('projectDir.configLink', { symlink: configSymlink, dataPath })}\n`);
}

/**
 * Ensure project directory is set up, creating if needed
 */
export function ensureProjectDir(projectRoot: string): void {
  if (!isProjectDirSetup(projectRoot)) {
    setupProjectDir(projectRoot);
  }
}

/**
 * Get the absolute path to a file within the project directory
 * Files go in .spck-editor/{filename} (local) or .spck-editor/config/{filename} (symlinked)
 * Config files (like connection-settings.json) go in the config subdirectory
 */
export function getProjectFilePath(projectRoot: string, filename: string): string {
  const projectDir = getProjectDirPath(projectRoot);

  // Config files go in the symlinked config directory
  const configFiles = ['connection-settings.json', '.credentials.json', 'spck-cli.config.json'];
  if (configFiles.includes(filename)) {
    const configSymlink = getConfigSymlinkPath(projectRoot);
    return path.join(configSymlink, filename);
  }

  // All other files go in the local .spck-editor directory
  return path.join(projectDir, filename);
}

/**
 * Remove project directory and all associated data
 * WARNING: This deletes the data directory in home and the local .spck-editor directory
 */
export function removeProjectDir(projectRoot: string): void {
  const projectDir = getProjectDirPath(projectRoot);
  const dataPath = getProjectDataPath(projectRoot);

  // Remove .spck-editor directory if exists (includes config symlink and local files)
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  // Remove data directory in home if exists
  if (fs.existsSync(dataPath)) {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
}
