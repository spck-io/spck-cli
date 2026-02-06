/**
 * .gitignore file management utilities
 * Handles checking and updating .gitignore files
 */

import * as fs from 'fs';
import * as path from 'path';

const SPCK_EDITOR_PATTERN = '.spck-editor/';

/**
 * Check if .gitignore exists in a directory
 */
export function gitignoreExists(directory: string): boolean {
  const gitignorePath = path.join(directory, '.gitignore');
  return fs.existsSync(gitignorePath);
}

/**
 * Check if .gitignore contains the .spck-editor pattern
 * Returns true if the pattern is found (exact match or as part of a line)
 */
export function isSpckEditorIgnored(directory: string): boolean {
  const gitignorePath = path.join(directory, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const lines = content.split('\n');

    // Check if any line contains .spck-editor/ (ignoring comments and whitespace)
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      // Check if line contains .spck-editor/ pattern
      if (trimmed === SPCK_EDITOR_PATTERN || trimmed === '.spck-editor') {
        return true;
      }
    }

    return false;
  } catch (error) {
    // If we can't read the file, assume it's not ignored
    return false;
  }
}

/**
 * Add .spck-editor/ to .gitignore
 * Creates .gitignore if it doesn't exist
 * Appends the pattern if not already present
 */
export function addSpckEditorToGitignore(directory: string): void {
  const gitignorePath = path.join(directory, '.gitignore');

  // Check if already ignored
  if (isSpckEditorIgnored(directory)) {
    return; // Already present, nothing to do
  }

  let content = '';

  if (fs.existsSync(gitignorePath)) {
    // Read existing content
    content = fs.readFileSync(gitignorePath, 'utf8');

    // Ensure content ends with newline
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
  }

  // Add comment and pattern
  const addition = `\n# Spck CLI project data (symlink to ~/.spck-editor/projects/)\n${SPCK_EDITOR_PATTERN}\n`;

  // Write back to file
  fs.writeFileSync(gitignorePath, content + addition, 'utf8');
}

/**
 * Get the full path to .gitignore in a directory
 */
export function getGitignorePath(directory: string): string {
  return path.join(directory, '.gitignore');
}
