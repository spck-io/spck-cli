/**
 * Tests for .gitignore utilities
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  gitignoreExists,
  isSpckEditorIgnored,
  addSpckEditorToGitignore,
  getGitignorePath,
} from '../gitignore';

describe('gitignore utilities', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spck-gitignore-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('gitignoreExists', () => {
    it('should return false when .gitignore does not exist', () => {
      expect(gitignoreExists(tempDir)).toBe(false);
    });

    it('should return true when .gitignore exists', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n', 'utf8');

      expect(gitignoreExists(tempDir)).toBe(true);
    });
  });

  describe('isSpckEditorIgnored', () => {
    it('should return false when .gitignore does not exist', () => {
      expect(isSpckEditorIgnored(tempDir)).toBe(false);
    });

    it('should return false when .spck-editor/ is not in .gitignore', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\ndist/\n', 'utf8');

      expect(isSpckEditorIgnored(tempDir)).toBe(false);
    });

    it('should return true when .spck-editor/ is in .gitignore', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.spck-editor/\ndist/\n', 'utf8');

      expect(isSpckEditorIgnored(tempDir)).toBe(true);
    });

    it('should return true when .spck-editor (without slash) is in .gitignore', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.spck-editor\ndist/\n', 'utf8');

      expect(isSpckEditorIgnored(tempDir)).toBe(true);
    });

    it('should ignore comments in .gitignore', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(
        gitignorePath,
        '# This is a comment\nnode_modules/\n# .spck-editor/\ndist/\n',
        'utf8'
      );

      expect(isSpckEditorIgnored(tempDir)).toBe(false);
    });

    it('should ignore empty lines in .gitignore', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n\n\ndist/\n', 'utf8');

      expect(isSpckEditorIgnored(tempDir)).toBe(false);
    });

    it('should handle .gitignore with only whitespace lines', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '   \n\t\n\n', 'utf8');

      expect(isSpckEditorIgnored(tempDir)).toBe(false);
    });
  });

  describe('addSpckEditorToGitignore', () => {
    it('should create .gitignore with .spck-editor/ when file does not exist', () => {
      addSpckEditorToGitignore(tempDir);

      const gitignorePath = path.join(tempDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('.spck-editor/');
      expect(content).toContain('# Spck CLI project data');
    });

    it('should append .spck-editor/ to existing .gitignore', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\ndist/\n', 'utf8');

      addSpckEditorToGitignore(tempDir);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('dist/');
      expect(content).toContain('.spck-editor/');
      expect(content).toContain('# Spck CLI project data');
    });

    it('should add newline before comment if .gitignore does not end with newline', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/', 'utf8'); // No trailing newline

      addSpckEditorToGitignore(tempDir);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toBe('node_modules/\n\n# Spck CLI project data (symlink to ~/.spck-editor/projects/)\n.spck-editor/\n');
    });

    it('should not add .spck-editor/ if already present', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      const initialContent = 'node_modules/\n.spck-editor/\ndist/\n';
      fs.writeFileSync(gitignorePath, initialContent, 'utf8');

      addSpckEditorToGitignore(tempDir);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      // Content should be unchanged
      expect(content).toBe(initialContent);
    });

    it('should not add if .spck-editor (without slash) is present', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      const initialContent = 'node_modules/\n.spck-editor\ndist/\n';
      fs.writeFileSync(gitignorePath, initialContent, 'utf8');

      addSpckEditorToGitignore(tempDir);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      // Content should be unchanged
      expect(content).toBe(initialContent);
    });

    it('should handle empty .gitignore file', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '', 'utf8');

      addSpckEditorToGitignore(tempDir);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('.spck-editor/');
      expect(content).toContain('# Spck CLI project data');
    });
  });

  describe('getGitignorePath', () => {
    it('should return correct .gitignore path', () => {
      const expected = path.join(tempDir, '.gitignore');
      expect(getGitignorePath(tempDir)).toBe(expected);
    });
  });
});
