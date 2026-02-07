/**
 * Project directory management with symlink support
 * Stores .spck-editor as a symlink to ~/.spck-editor/project/{project_id}
 * This prevents accidental git commits of secrets
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const PROJECT_DIR_NAME = '.spck-editor';

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
 * Get the symlink path in the project directory
 */
export function getProjectSymlinkPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DIR_NAME);
}

/**
 * Check if the project directory exists and is properly set up
 */
export function isProjectDirSetup(projectRoot: string): boolean {
  const symlinkPath = getProjectSymlinkPath(projectRoot);
  const dataPath = getProjectDataPath(projectRoot);

  // Check if symlink exists
  if (!fs.existsSync(symlinkPath)) {
    return false;
  }

  // Check if it's a symlink
  try {
    const stats = fs.lstatSync(symlinkPath);
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
 * Setup the project directory with symlink
 * Creates ~/.spck-editor/projects/{project_id}/ and symlinks to it
 */
export function setupProjectDir(projectRoot: string): void {
  const symlinkPath = getProjectSymlinkPath(projectRoot);
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

  // Handle existing .spck-editor in project directory
  if (fs.existsSync(symlinkPath)) {
    const stats = fs.lstatSync(symlinkPath);

    if (stats.isSymbolicLink()) {
      // Already a symlink - check if it points to the right place
      const target = fs.readlinkSync(symlinkPath);
      if (target === dataPath) {
        // Already correctly set up
        return;
      }

      // Points to wrong location - remove and recreate
      fs.unlinkSync(symlinkPath);
    } else {
      console.error('\n❌ Fatal Error: Cannot create symlink .spck-editor - path already exists');
      process.exit(1);
    }
  }

  // Create symlink
  fs.symlinkSync(dataPath, symlinkPath, 'dir');

  console.log(`✅ Project directory configured`);
  console.log(`   Symlink: ${symlinkPath}`);
  console.log(`   Data:    ${dataPath}\n`);
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
 * Always resolves through the symlink to the actual data directory
 */
export function getProjectFilePath(projectRoot: string, filename: string): string {
  const symlinkPath = getProjectSymlinkPath(projectRoot);
  return path.join(symlinkPath, filename);
}

/**
 * Remove project directory and all associated data
 * WARNING: This deletes the data directory in home, not just the symlink
 */
export function removeProjectDir(projectRoot: string): void {
  const symlinkPath = getProjectSymlinkPath(projectRoot);
  const dataPath = getProjectDataPath(projectRoot);

  // Remove symlink if exists
  if (fs.existsSync(symlinkPath)) {
    const stats = fs.lstatSync(symlinkPath);
    if (stats.isSymbolicLink()) {
      fs.unlinkSync(symlinkPath);
    } else {
      // Regular directory - remove recursively
      fs.rmSync(symlinkPath, { recursive: true, force: true });
    }
  }

  // Remove data directory if exists
  if (fs.existsSync(dataPath)) {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
}
