import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
/**
 * Tests for FilesystemService
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fossilDelta from 'fossil-delta';
import { FilesystemService } from '../FilesystemService.js';
import { ErrorCode } from '../../types.js';

describe('FilesystemService', () => {
  let service: FilesystemService;
  let testRoot: string;
  let mockSocket: any;

  beforeEach(async () => {
    // Create temporary test directory
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-test-'));

    service = new FilesystemService(testRoot, {
      maxFileSize: '10MB',
      watchIgnorePatterns: ['.git', 'node_modules'],
    });

    mockSocket = {
      id: 'test-socket',
      data: { uid: 'test-user', deviceId: 'test-device' },
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      broadcast: {
        emit: vi.fn(),
      },
    };
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  describe('Path Validation & Security', () => {
    it('should accept valid relative paths', async () => {
      await fs.writeFile(path.join(testRoot, 'test.txt'), 'content');

      const result = await service.handle('exists', { path: '/test.txt' }, mockSocket);

      expect(result.exists).toBe(true);
    });

    it('should prevent directory traversal attacks', async () => {
      await expect(
        service.handle('exists', { path: '../../etc/passwd' }, mockSocket)
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PATH,
        message: expect.stringContaining('directory traversal'),
      });
    });

    it('should prevent access outside root directory', async () => {
      // The path validation happens during normalization
      // When path escapes root, it gets clamped to root, so file won't exist
      const result = await service.handle(
        'exists',
        { path: '/../../../../etc/passwd' },
        mockSocket
      );

      // Should not find /etc/passwd since it's outside the test root
      expect(result.exists).toBe(false);
    });

    it('should normalize paths correctly', async () => {
      await fs.writeFile(path.join(testRoot, 'test.txt'), 'content');

      const result = await service.handle('exists', { path: '//test.txt' }, mockSocket);

      expect(result.exists).toBe(true);
    });

    it('should strip query strings from paths (cache-busters)', async () => {
      await fs.writeFile(path.join(testRoot, 'logo.png'), 'data');

      const result = await service.handle(
        'exists',
        { path: '/logo.png?b=1775829760178' },
        mockSocket
      );

      expect(result.exists).toBe(true);
    });

    it('should strip URL fragments from paths', async () => {
      await fs.writeFile(path.join(testRoot, 'page.html'), '<html/>');

      const result = await service.handle(
        'exists',
        { path: '/page.html#section' },
        mockSocket
      );

      expect(result.exists).toBe(true);
    });
  });

  describe('File Operations - exists', () => {
    it('should return true for existing file', async () => {
      await fs.writeFile(path.join(testRoot, 'exists.txt'), 'content');

      const result = await service.handle('exists', { path: '/exists.txt' }, mockSocket);

      expect(result).toEqual({ exists: true });
    });

    it('should return false for non-existing file', async () => {
      const result = await service.handle('exists', { path: '/missing.txt' }, mockSocket);

      expect(result).toEqual({ exists: false });
    });

    it('should return true for existing directory', async () => {
      await fs.mkdir(path.join(testRoot, 'testdir'));

      const result = await service.handle('exists', { path: '/testdir' }, mockSocket);

      expect(result).toEqual({ exists: true });
    });
  });

  describe('File Operations - readFile', () => {
    it('should read text file with UTF-8 encoding', async () => {
      const content = 'Hello, World! 你好';
      await fs.writeFile(path.join(testRoot, 'hello.txt'), content, 'utf8');

      const result = await service.handle(
        'readFile',
        { path: '/hello.txt', encoding: 'utf8' },
        mockSocket
      );

      expect(result.contents).toBe(content);
      expect(result.encoding).toBe('utf8');
      expect(result.sha256).toBeTruthy();
      expect(result.size).toBe(Buffer.from(content, 'utf8').length);
    });

    it('should compute correct SHA256 hash', async () => {
      const content = 'test content';
      await fs.writeFile(path.join(testRoot, 'test.txt'), content);

      const result = await service.handle(
        'readFile',
        { path: '/test.txt' },
        mockSocket
      );

      const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
      expect(result.sha256).toBe(expectedHash);
    });

    it('should default to UTF-8 encoding', async () => {
      await fs.writeFile(path.join(testRoot, 'default.txt'), 'content');

      const result = await service.handle(
        'readFile',
        { path: '/default.txt' },
        mockSocket
      );

      expect(result.encoding).toBe('utf8');
    });

    it('should handle binary files', async () => {
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
      await fs.writeFile(path.join(testRoot, 'binary.dat'), buffer);

      const result = await service.handle(
        'readFile',
        { path: '/binary.dat', encoding: 'binary', requestId: 123 },
        mockSocket
      );

      expect(result.encoding).toBe('binary');
      expect(result.sha256).toBeTruthy();
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.buffer).toEqual(buffer);
    });

    it('should throw error for non-existing file', async () => {
      await expect(
        service.handle('readFile', { path: '/missing.txt' }, mockSocket)
      ).rejects.toMatchObject({
        code: ErrorCode.FILE_NOT_FOUND,
      });
    });

    it('should reject files exceeding size limit', async () => {
      // Create a large file (11MB, exceeds 10MB limit)
      const largeContent = 'x'.repeat(11 * 1024 * 1024);
      await fs.writeFile(path.join(testRoot, 'large.txt'), largeContent);

      await expect(
        service.handle('readFile', { path: '/large.txt' }, mockSocket)
      ).rejects.toMatchObject({
        code: ErrorCode.FILE_TOO_LARGE,
        message: expect.stringContaining('too large'),
      });
    });
  });

  describe('File Operations - writeFile', () => {
    it('should write text file', async () => {
      const content = 'test content';

      const result = await service.handle(
        'write',
        { path: '/new.txt', contents: content },
        mockSocket
      );

      expect(result.success).toBe(true);
      expect(result.sha256).toBeTruthy();

      const written = await fs.readFile(path.join(testRoot, 'new.txt'), 'utf8');
      expect(written).toBe(content);
    });

    it('should overwrite existing file', async () => {
      await fs.writeFile(path.join(testRoot, 'overwrite.txt'), 'old content');

      await service.handle(
        'write',
        { path: '/overwrite.txt', contents: 'new content' },
        mockSocket
      );

      const content = await fs.readFile(path.join(testRoot, 'overwrite.txt'), 'utf8');
      expect(content).toBe('new content');
    });

    it('should detect write conflicts with expectedHash', async () => {
      await fs.writeFile(path.join(testRoot, 'conflict.txt'), 'original');

      const wrongHash = 'wrong-hash-value';

      await expect(
        service.handle(
          'write',
          {
            path: '/conflict.txt',
            contents: 'modified',
            expectedHash: wrongHash,
          },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.WRITE_CONFLICT,
        message: expect.stringContaining('modified on server'),
      });
    });

    it('should allow write when expectedHash matches', async () => {
      const original = 'original content';
      await fs.writeFile(path.join(testRoot, 'match.txt'), original);

      const correctHash = crypto.createHash('sha256').update(original).digest('hex');

      const result = await service.handle(
        'write',
        {
          path: '/match.txt',
          contents: 'new content',
          expectedHash: correctHash,
        },
        mockSocket
      );

      expect(result.success).toBe(true);
    });

    it('should write binary file via writeBinary (Buffer, single chunk)', async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header

      const result = await service.handle(
        'writeBinary',
        { path: '/image.png', uploadId: 'upload-1', chunk: 0, totalChunks: 1, data: bytes },
        mockSocket
      );

      expect(result.success).toBe(true);
      expect(result.sha256).toBeTruthy();

      const written = await fs.readFile(path.join(testRoot, 'image.png'));
      expect(written).toEqual(bytes);
    });

    it('should write binary file atomically via writeBinary', async () => {
      const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD]);

      const result = await service.handle(
        'writeBinary',
        { path: '/data.bin', uploadId: 'upload-2', chunk: 0, totalChunks: 1, data: bytes, atomic: true },
        mockSocket
      );

      expect(result.success).toBe(true);

      const written = await fs.readFile(path.join(testRoot, 'data.bin'));
      expect(written).toEqual(bytes);
    });

    it('should write empty binary file', async () => {
      const result = await service.handle(
        'write',
        { path: '/empty.bin', contents: '', encoding: 'binary' },
        mockSocket
      );

      expect(result.success).toBe(true);

      const written = await fs.readFile(path.join(testRoot, 'empty.bin'));
      expect(written.length).toBe(0);
    });

    it('should preserve all byte values when writing binary via writeBinary', async () => {
      // Full range of byte values 0x00–0xFF
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

      await service.handle(
        'writeBinary',
        { path: '/allbytes.bin', uploadId: 'upload-3', chunk: 0, totalChunks: 1, data: bytes },
        mockSocket
      );

      const written = await fs.readFile(path.join(testRoot, 'allbytes.bin'));
      expect(written).toEqual(bytes);
    });

    it('should set executable permission when requested', async () => {
      await service.handle(
        'write',
        {
          path: '/script.sh',
          contents: '#!/bin/bash\necho hello',
          executable: true,
        },
        mockSocket
      );

      const stats = await fs.stat(path.join(testRoot, 'script.sh'));
      // Check if executable bit is set (mode & 0o100)
      expect(stats.mode & 0o100).toBeTruthy();
    });
  });

  describe('File Operations - patchFile (Fossil Delta)', () => {
    it('should apply fossil-delta patch successfully', async () => {
      const original = Buffer.from('Hello, World!');
      const modified = Buffer.from('Hello, Universe!');
      await fs.writeFile(path.join(testRoot, 'patch.txt'), original);

      const delta = fossilDelta.create(original, modified);
      const baseHash = crypto.createHash('sha256').update(original).digest('hex');
      const newHash = crypto.createHash('sha256').update(modified).digest('hex');

      const result = await service.handle(
        'patchFile',
        {
          path: '/patch.txt',
          delta: delta, // Pass Buffer directly
          baseHash,
          newHash,
        },
        mockSocket
      );

      expect(result.success).toBe(true);
      expect(result.finalHash).toBe(newHash);

      const patched = await fs.readFile(path.join(testRoot, 'patch.txt'));
      expect(patched.toString()).toBe('Hello, Universe!');
    });

    it('should reject patch when base hash mismatches', async () => {
      await fs.writeFile(path.join(testRoot, 'mismatch.txt'), 'content');

      const delta = Buffer.from([0x00]);
      const wrongBaseHash = 'wrong-hash';

      await expect(
        service.handle(
          'patchFile',
          {
            path: '/mismatch.txt',
            delta: Array.from(delta),
            baseHash: wrongBaseHash,
          },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.WRITE_CONFLICT,
        message: expect.stringContaining('Base hash mismatch'),
      });
    });

    it('should verify final hash after patching', async () => {
      const original = Buffer.from('test');
      const modified = Buffer.from('tested');
      await fs.writeFile(path.join(testRoot, 'verify.txt'), original);

      const delta = fossilDelta.create(original, modified);
      const baseHash = crypto.createHash('sha256').update(original).digest('hex');
      const wrongNewHash = 'wrong-final-hash';

      await expect(
        service.handle(
          'patchFile',
          {
            path: '/verify.txt',
            delta: delta, // Pass Buffer directly
            baseHash,
            newHash: wrongNewHash,
          },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.DELTA_PATCH_FAILED,
        message: expect.stringContaining('Final hash mismatch'),
      });
    });
  });

  describe('File Operations - getFileHash', () => {
    it('should return file hash and metadata', async () => {
      const content = 'test content';
      await fs.writeFile(path.join(testRoot, 'hash.txt'), content);

      const result = await service.handle('getFileHash', { path: '/hash.txt' }, mockSocket);

      const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(Buffer.from(content).length);
      expect(result.mtime).toBeGreaterThan(0);
    });
  });

  describe('File Operations - remove', () => {
    it('should remove file', async () => {
      await fs.writeFile(path.join(testRoot, 'remove.txt'), 'content');

      const result = await service.handle('remove', { path: '/remove.txt' }, mockSocket);

      expect(result.success).toBe(true);

      await expect(fs.access(path.join(testRoot, 'remove.txt'))).rejects.toThrow();
    });

    it('should remove directory recursively', async () => {
      const dirPath = path.join(testRoot, 'removedir');
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, 'file.txt'), 'content');

      const result = await service.handle('remove', { path: '/removedir' }, mockSocket);

      expect(result.success).toBe(true);
      await expect(fs.access(dirPath)).rejects.toThrow();
    });

    it('should succeed for non-existing file (idempotent)', async () => {
      const result = await service.handle('remove', { path: '/nonexistent.txt' }, mockSocket);
      expect(result.success).toBe(true);
    });
  });

  describe('Directory Operations - mkdir', () => {
    it('should create directory', async () => {
      const result = await service.handle('mkdir', { path: '/newdir' }, mockSocket);

      expect(result.success).toBe(true);

      const stats = await fs.stat(path.join(testRoot, 'newdir'));
      expect(stats.isDirectory()).toBe(true);
    });

    it('should create nested directories with mkdirp', async () => {
      const result = await service.handle('mkdirp', { path: '/a/b/c' }, mockSocket);

      expect(result.success).toBe(true);

      const stats = await fs.stat(path.join(testRoot, 'a', 'b', 'c'));
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe('Directory Operations - readdir', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(testRoot, 'readdir-test'));
      await fs.writeFile(path.join(testRoot, 'readdir-test', 'file1.txt'), '');
      await fs.writeFile(path.join(testRoot, 'readdir-test', 'file2.txt'), '');
      await fs.mkdir(path.join(testRoot, 'readdir-test', 'subdir'));
    });

    it('should list directory contents', async () => {
      const result = await service.handle('readdir', { path: '/readdir-test' }, mockSocket);

      expect(result.entries).toHaveLength(3);
      expect(result.entries).toEqual(
        expect.arrayContaining(['file1.txt', 'file2.txt', 'subdir'])
      );
    });

    it('should skip files when skipFiles is true', async () => {
      const result = await service.handle(
        'readdir',
        { path: '/readdir-test', skipFiles: true },
        mockSocket
      );

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toBe('subdir');
    });

    it('should skip folders when skipFolders is true', async () => {
      const result = await service.handle(
        'readdir',
        { path: '/readdir-test', skipFolders: true },
        mockSocket
      );

      expect(result.entries).toHaveLength(2);
      expect(result.entries).toEqual(
        expect.arrayContaining(['file1.txt', 'file2.txt'])
      );
    });

    it('should throw error for non-existing directory', async () => {
      await expect(
        service.handle('readdir', { path: '/nonexistent' }, mockSocket)
      ).rejects.toMatchObject({
        code: ErrorCode.FILE_NOT_FOUND,
      });
    });
  });

  describe('Directory Operations - readdirDeep', () => {
    beforeEach(async () => {
      // Create nested directory structure
      await fs.mkdir(path.join(testRoot, 'deep'));
      await fs.writeFile(path.join(testRoot, 'deep', 'root.txt'), '');
      await fs.mkdir(path.join(testRoot, 'deep', 'level1'));
      await fs.writeFile(path.join(testRoot, 'deep', 'level1', 'file1.txt'), '');
      await fs.mkdir(path.join(testRoot, 'deep', 'level1', 'level2'));
      await fs.writeFile(path.join(testRoot, 'deep', 'level1', 'level2', 'file2.txt'), '');
      await fs.mkdir(path.join(testRoot, 'deep', '.git'));
      await fs.writeFile(path.join(testRoot, 'deep', '.git', 'config'), '');
      await fs.mkdir(path.join(testRoot, 'deep', 'node_modules'));
      await fs.writeFile(path.join(testRoot, 'deep', 'node_modules', 'package.json'), '');
    });

    it('should recursively list all files and folders', async () => {
      const result = await service.handle('readdirDeep', { path: '/deep' }, mockSocket);

      expect(result).toContain('deep/root.txt');
      expect(result).toContain('deep/level1/file1.txt');
      expect(result).toContain('deep/level1/level2/file2.txt');

      expect(result).toContain('deep/level1');
      expect(result).toContain('deep/level1/level2');

      // Should NOT include .git by default (auto-ignored)
      // node_modules is included
      expect(result).toContain('deep/node_modules');
    });

    it('should return only files when folders=false', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', files: true, folders: false },
        mockSocket
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('deep/root.txt');
      expect(result).toContain('deep/level1/file1.txt');
      // Should not contain folders
      expect(result).not.toContain('deep/level1');
    });

    it('should return only folders when files=false', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', files: false, folders: true },
        mockSocket
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('deep/level1');
      expect(result).toContain('deep/level1/level2');
      // Should not contain files
      expect(result).not.toContain('deep/root.txt');
    });

    it('should filter ignored names', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', ignoreName: '.git:node_modules' },
        mockSocket
      );

      // Should NOT contain .git or node_modules
      expect(result.some((f: string) => f.includes('.git'))).toBe(false);
      expect(result.some((f: string) => f.includes('node_modules'))).toBe(false);

      // Should still contain other files/folders
      expect(result).toContain('deep/root.txt');
      expect(result).toContain('deep/level1');
    });

    it('should handle empty ignoreName gracefully', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', ignoreName: '' },
        mockSocket
      );

      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle ignoreName with spaces', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', ignoreName: ' .git : node_modules ' },
        mockSocket
      );

      expect(result.some((f: string) => f.includes('.git'))).toBe(false);
      expect(result.some((f: string) => f.includes('node_modules'))).toBe(false);
    });

    it('should throw error for non-existing directory', async () => {
      await expect(
        service.handle('readdirDeep', { path: '/nonexistent' }, mockSocket)
      ).rejects.toMatchObject({
        code: ErrorCode.FILE_NOT_FOUND,
      });
    });

    it('should handle empty directory', async () => {
      await fs.mkdir(path.join(testRoot, 'empty'));

      const result = await service.handle('readdirDeep', { path: '/empty' }, mockSocket);

      expect(result).toEqual([]);
    });

    it('should filter results with matchPattern regex', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', matchPattern: '\\.txt$' },
        mockSocket
      );

      // Should only contain .txt files
      expect(result).toContain('deep/root.txt');
      expect(result).toContain('deep/level1/file1.txt');
      expect(result).toContain('deep/level1/level2/file2.txt');

      // Should NOT contain non-.txt files
      expect(result.some((f: string) => f.endsWith('.json'))).toBe(false);
    });

    it('should filter folders with matchPattern regex', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', files: false, folders: true, matchPattern: 'level' },
        mockSocket
      );

      // Should only contain folders with "level" in path
      expect(result).toContain('deep/level1');
      expect(result).toContain('deep/level1/level2');

      // Should NOT contain node_modules
      expect(result).not.toContain('deep/node_modules');
    });

    it('should limit results when limit parameter is provided', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', limit: 2 },
        mockSocket
      );

      // Should return exactly 2 results (folders + files combined)
      expect(result.length).toBe(2);
    });

    it('should combine matchPattern and limit correctly', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', matchPattern: '\\.txt$', limit: 2 },
        mockSocket
      );

      // Should return max 2 .txt files
      expect(result.length).toBeLessThanOrEqual(2);

      // All returned files should match the pattern
      result.forEach((file: string) => {
        expect(file).toMatch(/\.txt$/);
      });
    });

    it('should not truncate when limit is not reached', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', limit: 1000 },
        mockSocket
      );

      // Should return all results when limit is high
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle limit of 0', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', limit: 0 },
        mockSocket
      );

      expect(result).toEqual([]);
    });

    it('should handle limit of 1', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', limit: 1 },
        mockSocket
      );

      expect(result.length).toBe(1);
    });

    it('should return all results when no limit or pattern', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep' },
        mockSocket
      );

      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle invalid regex in matchPattern', async () => {
      await expect(
        service.handle(
          'readdirDeep',
          { path: '/deep', matchPattern: '[invalid(' },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
      });
    });

    it('should apply matchPattern to full relative path', async () => {
      const result = await service.handle(
        'readdirDeep',
        { path: '/deep', matchPattern: '^deep/level1/' },
        mockSocket
      );

      // Should only match paths starting with "deep/level1/"
      result.forEach((path: string) => {
        expect(path).toMatch(/^deep\/level1\//);
      });

      // Should NOT contain root.txt or node_modules
      expect(result).not.toContain('deep/root.txt');
      expect(result).not.toContain('deep/node_modules');
    });
  });

  describe('Directory Operations - rmdir', () => {
    it('should remove empty directory', async () => {
      await fs.mkdir(path.join(testRoot, 'emptydir'));

      const result = await service.handle('rmdir', { path: '/emptydir' }, mockSocket);

      expect(result.success).toBe(true);
      await expect(fs.access(path.join(testRoot, 'emptydir'))).rejects.toThrow();
    });

    it('should fail to remove non-empty directory', async () => {
      await fs.mkdir(path.join(testRoot, 'nonempty'));
      await fs.writeFile(path.join(testRoot, 'nonempty', 'file.txt'), '');

      await expect(
        service.handle('rmdir', { path: '/nonempty' }, mockSocket)
      ).rejects.toThrow();
    });
  });

  describe('File Metadata - lstat', () => {
    it('should return file metadata', async () => {
      await fs.writeFile(path.join(testRoot, 'stat.txt'), 'content');

      const result = await service.handle('lstat', { path: '/stat.txt' }, mockSocket);

      expect(result).toMatchObject({
        mode: expect.any(Number),
        size: expect.any(Number),
        mtimeMs: expect.any(Number),
        ctimeMs: expect.any(Number),
        atimeMs: expect.any(Number),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      });
    });

    it('should return directory metadata', async () => {
      await fs.mkdir(path.join(testRoot, 'statdir'));

      const result = await service.handle('lstat', { path: '/statdir' }, mockSocket);

      expect(result.isFile).toBe(false);
      expect(result.isDirectory).toBe(true);
    });
  });

  describe('File Manipulation - mv (move/rename)', () => {
    it('should rename file', async () => {
      await fs.writeFile(path.join(testRoot, 'old.txt'), 'content');

      const result = await service.handle(
        'mv',
        { src: '/old.txt', target: '/new.txt' },
        mockSocket
      );

      expect(result).toBe('file');

      await expect(fs.access(path.join(testRoot, 'old.txt'))).rejects.toThrow();
      const content = await fs.readFile(path.join(testRoot, 'new.txt'), 'utf8');
      expect(content).toBe('content');
    });

    it('should prevent overwrite when opts.overwrite is false', async () => {
      await fs.writeFile(path.join(testRoot, 'src.txt'), 'source');
      await fs.writeFile(path.join(testRoot, 'dst.txt'), 'destination');

      await expect(
        service.handle(
          'mv',
          { src: '/src.txt', target: '/dst.txt', opts: { overwrite: false } },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PATH,
        message: expect.stringContaining('already exists'),
      });
    });

    it('should allow overwrite when opts.overwrite is true', async () => {
      await fs.writeFile(path.join(testRoot, 'src2.txt'), 'source');
      await fs.writeFile(path.join(testRoot, 'dst2.txt'), 'destination');

      const result = await service.handle(
        'mv',
        { src: '/src2.txt', target: '/dst2.txt', opts: { overwrite: true } },
        mockSocket
      );

      expect(result).toBe('file');

      const content = await fs.readFile(path.join(testRoot, 'dst2.txt'), 'utf8');
      expect(content).toBe('source');
    });
  });

  describe('File Manipulation - copy', () => {
    it('should copy file', async () => {
      await fs.writeFile(path.join(testRoot, 'original.txt'), 'content');

      const result = await service.handle(
        'copy',
        { oldpath: '/original.txt', path: '/copy.txt' },
        mockSocket
      );

      expect(result).toBe('file');

      const original = await fs.readFile(path.join(testRoot, 'original.txt'), 'utf8');
      const copied = await fs.readFile(path.join(testRoot, 'copy.txt'), 'utf8');
      expect(copied).toBe(original);
    });

    it('should prevent overwrite when opts.overwrite is false', async () => {
      await fs.writeFile(path.join(testRoot, 'src-copy.txt'), 'source');
      await fs.writeFile(path.join(testRoot, 'dst-copy.txt'), 'destination');

      await expect(
        service.handle(
          'copy',
          {
            oldpath: '/src-copy.txt',
            path: '/dst-copy.txt',
            opts: { overwrite: false },
          },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PATH,
        message: expect.stringContaining('already exists'),
      });
    });
  });

  describe('Bulk Operations - bulkExists', () => {
    it('should check existence of multiple files with relative base path', async () => {
      // Create test files
      await fs.writeFile(path.join(testRoot, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(testRoot, 'file2.txt'), 'content2');
      await fs.mkdir(path.join(testRoot, 'subdir'));
      await fs.writeFile(path.join(testRoot, 'subdir', 'file3.txt'), 'content3');

      const result = await service.handle(
        'bulkExists',
        {
          path: '/',
          paths: ['file1.txt', 'file2.txt', 'missing.txt', 'subdir/file3.txt'],
        },
        mockSocket
      );

      expect(result).toEqual([1, 1, 0, 1]);
    });

    it('should check existence with basePath /', async () => {
      // Create nested directory structure
      await fs.mkdir(path.join(testRoot, 'home'));
      await fs.mkdir(path.join(testRoot, 'home', 'user'));
      await fs.mkdir(path.join(testRoot, 'home', 'user', 'project'));
      await fs.writeFile(path.join(testRoot, 'home', 'user', 'project', 'index.js'), 'console.log("hello")');
      await fs.writeFile(path.join(testRoot, 'home', 'user', 'project', 'README.md'), '# Project');

      const result = await service.handle(
        'bulkExists',
        {
          path: '/',
          paths: ['home/user/project/index.js', 'home/user/project/README.md', 'home/user/project/missing.js'],
        },
        mockSocket
      );

      expect(result).toEqual([1, 1, 0]);
    });

    it('should validate paths and prevent directory traversal in bulkExists', async () => {
      await fs.writeFile(path.join(testRoot, 'safe.txt'), 'content');

      const result = await service.handle(
        'bulkExists',
        {
          path: '/',
          paths: ['safe.txt', '../../etc/passwd'],
        },
        mockSocket
      );

      // safe.txt exists, but ../../etc/passwd should be clamped and return 0
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(0);
    });

    it('should return empty array when paths is empty', async () => {
      const result = await service.handle(
        'bulkExists',
        {
          path: '/',
          paths: [],
        },
        mockSocket
      );

      expect(result).toEqual([]);
    });

    it('should throw error when paths parameter is not an array', async () => {
      await expect(
        service.handle(
          'bulkExists',
          {
            path: '/',
            paths: 'not-an-array',
          },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
        message: expect.stringContaining('paths must be an array'),
      });
    });
  });

  describe('File Operations - stat', () => {
    it('should return size, mtime, isFile, isDirectory for a file', async () => {
      const content = 'hello stat';
      await fs.writeFile(path.join(testRoot, 'stat-file.txt'), content);

      const result = await service.handle('stat', { path: '/stat-file.txt' }, mockSocket);

      expect(result.size).toBe(Buffer.byteLength(content));
      expect(result.mtime).toBeGreaterThan(0);
      expect(result.isFile).toBe(true);
      expect(result.isDirectory).toBe(false);
    });

    it('should report isDirectory for a directory', async () => {
      await fs.mkdir(path.join(testRoot, 'statdir'));

      const result = await service.handle('stat', { path: '/statdir' }, mockSocket);

      expect(result.isDirectory).toBe(true);
      expect(result.isFile).toBe(false);
    });

    it('should throw FILE_NOT_FOUND for missing path', async () => {
      await expect(
        service.handle('stat', { path: '/no-such-file.txt' }, mockSocket)
      ).rejects.toMatchObject({ code: ErrorCode.FILE_NOT_FOUND });
    });
  });

  describe('File Operations - readFile (range read)', () => {
    let fileContent: Buffer;
    const FILE = '/range.bin';

    beforeEach(async () => {
      // 100-byte file: byte value equals its index
      fileContent = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
      await fs.writeFile(path.join(testRoot, 'range.bin'), fileContent);
    });

    it('should read a byte range from the middle of the file', async () => {
      const result = await service.handle(
        'readFile',
        { path: FILE, offset: 10, length: 20 },
        mockSocket
      );

      expect(result.buffer).toEqual(fileContent.subarray(10, 30));
      expect(result.offset).toBe(10);
      expect(result.length).toBe(20);
      expect(result.size).toBe(100);
      expect(result.encoding).toBe('binary');
    });

    it('should read from offset 0', async () => {
      const result = await service.handle(
        'readFile',
        { path: FILE, offset: 0, length: 5 },
        mockSocket
      );

      expect(result.buffer).toEqual(fileContent.subarray(0, 5));
    });

    it('should read to end of file when length reaches past EOF', async () => {
      // Request 50 bytes starting at offset 80 — only 20 bytes remain
      const result = await service.handle(
        'readFile',
        { path: FILE, offset: 80, length: 50 },
        mockSocket
      );

      expect(result.buffer).toEqual(fileContent.subarray(80, 100));
      expect(result.length).toBe(20);
    });

    it('should use remaining bytes when length is omitted', async () => {
      const result = await service.handle(
        'readFile',
        { path: FILE, offset: 90 },
        mockSocket
      );

      expect(result.buffer).toEqual(fileContent.subarray(90));
      expect(result.length).toBe(10);
    });

    it('should bypass the maxFileSize limit for range reads', async () => {
      // Create a file larger than the 10 MB limit
      const bigPath = path.join(testRoot, 'big.bin');
      const bigBuf = Buffer.alloc(11 * 1024 * 1024, 0xab);
      await fs.writeFile(bigPath, bigBuf);

      // Full read should fail with FILE_TOO_LARGE
      await expect(
        service.handle('readFile', { path: '/big.bin' }, mockSocket)
      ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });

      // Range read of the same file must succeed
      const result = await service.handle(
        'readFile',
        { path: '/big.bin', offset: 0, length: 64 },
        mockSocket
      );

      expect(result.buffer.length).toBe(64);
      expect(result.size).toBe(bigBuf.length);
    });

    it('should throw INVALID_PARAMS when offset is negative', async () => {
      await expect(
        service.handle('readFile', { path: FILE, offset: -1, length: 10 }, mockSocket)
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
    });

    it('should throw INVALID_PARAMS when range produces zero length', async () => {
      // offset at end-of-file → length clamps to 0
      await expect(
        service.handle('readFile', { path: FILE, offset: 100, length: 10 }, mockSocket)
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
    });

    it('should throw FILE_NOT_FOUND for range read on missing file', async () => {
      await expect(
        service.handle('readFile', { path: '/missing.bin', offset: 0, length: 10 }, mockSocket)
      ).rejects.toMatchObject({ code: ErrorCode.FILE_NOT_FOUND });
    });
  });

  async function collectBinary(iterable: AsyncIterable<Buffer>): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of iterable) parts.push(chunk);
    return Buffer.concat(parts);
  }

  describe('File Operations - readFileBinary (async iterable)', () => {
    it('should return async iterable with correct metadata for small file', async () => {
      const content = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header
      await fs.writeFile(path.join(testRoot, 'small.png'), content);

      const result = await service.handle('readFileBinary', { path: '/small.png' }, mockSocket);

      expect(result.totalChunks).toBe(1);
      expect(result.size).toBe(4);
      expect(typeof result[Symbol.asyncIterator]).toBe('function');
      expect(await collectBinary(result)).toEqual(content);
    });

    it('should stream multi-chunk file with correct chunk sizes', async () => {
      const CHUNK = 512;
      const content = Buffer.from(Array.from({ length: 1500 }, (_, i) => i % 256));
      await fs.writeFile(path.join(testRoot, 'multi.bin'), content);

      const result = await service.handle('readFileBinary', { path: '/multi.bin', chunkSize: CHUNK }, mockSocket);
      expect(result.totalChunks).toBe(3);
      expect(result.size).toBe(1500);

      const chunks: Buffer[] = [];
      for await (const chunk of result) {
        expect(Buffer.isBuffer(chunk)).toBe(true);
        chunks.push(chunk);
      }
      expect(chunks.length).toBe(3);
      expect(Buffer.concat(chunks)).toEqual(content);
    });

    it('should reassemble to exact original bytes', async () => {
      const content = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      await fs.writeFile(path.join(testRoot, 'allbytes2.bin'), content);

      const result = await service.handle('readFileBinary', { path: '/allbytes2.bin', chunkSize: 100 }, mockSocket);
      expect(await collectBinary(result)).toEqual(content);
    });

    it('should handle empty file', async () => {
      await fs.writeFile(path.join(testRoot, 'empty2.bin'), Buffer.alloc(0));
      const result = await service.handle('readFileBinary', { path: '/empty2.bin' }, mockSocket);
      expect(result.size).toBe(0);
      expect(result.totalChunks).toBe(1);
      expect((await collectBinary(result)).length).toBe(0);
    });

    it('should throw FILE_NOT_FOUND for missing file', async () => {
      await expect(
        service.handle('readFileBinary', { path: '/missing.bin' }, mockSocket)
      ).rejects.toMatchObject({ code: ErrorCode.FILE_NOT_FOUND });
    });

    it('should support concurrent reads of the same file without interference', async () => {
      const content = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
      await fs.writeFile(path.join(testRoot, 'concurrent.bin'), content);

      // Start two reads concurrently
      const [r1, r2] = await Promise.all([
        service.handle('readFileBinary', { path: '/concurrent.bin', chunkSize: 100 }, mockSocket),
        service.handle('readFileBinary', { path: '/concurrent.bin', chunkSize: 150 }, mockSocket),
      ]);

      const [buf1, buf2] = await Promise.all([collectBinary(r1), collectBinary(r2)]);
      expect(buf1).toEqual(content);
      expect(buf2).toEqual(content);
    });

    it('should return sha256-verifiable content matching the written file', async () => {
      const content = Buffer.from('binary content for hash check');
      await fs.writeFile(path.join(testRoot, 'hashcheck.bin'), content);
      const expected = crypto.createHash('sha256').update(content).digest('hex');

      const result = await service.handle('readFileBinary', { path: '/hashcheck.bin' }, mockSocket);
      const assembled = await collectBinary(result);
      const actual = crypto.createHash('sha256').update(assembled).digest('hex');
      expect(actual).toBe(expected);
    });
  });

  describe('File Operations - writeBinary', () => {
    it('should write binary Buffer directly', async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const result = await service.handle('writeBinary',
        { path: '/out.png', data: bytes },
        mockSocket
      );
      expect(result.success).toBe(true);
      expect(result.sha256).toBeTruthy();
      expect(await fs.readFile(path.join(testRoot, 'out.png'))).toEqual(bytes);
    });

    it('should write all byte values correctly', async () => {
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      await service.handle('writeBinary', { path: '/allbytes3.bin', data: bytes }, mockSocket);
      expect(await fs.readFile(path.join(testRoot, 'allbytes3.bin'))).toEqual(bytes);
    });

    it('should write atomically when requested', async () => {
      const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF]);
      const result = await service.handle('writeBinary',
        { path: '/atomic.bin', data: bytes, atomic: true },
        mockSocket
      );
      expect(result.success).toBe(true);
      expect(await fs.readFile(path.join(testRoot, 'atomic.bin'))).toEqual(bytes);
    });

    it('should return sha256 of written content', async () => {
      const bytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const expected = crypto.createHash('sha256').update(bytes).digest('hex');
      const result = await service.handle('writeBinary', { path: '/sha.bin', data: bytes }, mockSocket);
      expect(result.sha256).toBe(expected);
    });

    it('should overwrite existing file', async () => {
      await fs.writeFile(path.join(testRoot, 'overwrite.bin'), Buffer.from([0xFF, 0xFF]));
      const newBytes = Buffer.from([0x01, 0x02, 0x03]);
      await service.handle('writeBinary', { path: '/overwrite.bin', data: newBytes }, mockSocket);
      expect(await fs.readFile(path.join(testRoot, 'overwrite.bin'))).toEqual(newBytes);
    });

    it('should detect write conflict when expectedHash does not match', async () => {
      const original = Buffer.from([0xAA, 0xBB]);
      await fs.writeFile(path.join(testRoot, 'conflict.bin'), original);

      await expect(
        service.handle('writeBinary', {
          path: '/conflict.bin',
          data: Buffer.from([0x01]),
          expectedHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        }, mockSocket)
      ).rejects.toMatchObject({ code: ErrorCode.WRITE_CONFLICT });
    });

    it('should write when expectedHash matches current file', async () => {
      const original = Buffer.from([0xAA, 0xBB, 0xCC]);
      await fs.writeFile(path.join(testRoot, 'match.bin'), original);
      const correctHash = crypto.createHash('sha256').update(original).digest('hex');

      const result = await service.handle('writeBinary', {
        path: '/match.bin',
        data: Buffer.from([0x11, 0x22]),
        expectedHash: correctHash,
      }, mockSocket);
      expect(result.success).toBe(true);
    });

    it('round-trip: writeBinary then readFileBinary returns identical bytes', async () => {
      const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7 + 13) % 256));
      await service.handle('writeBinary', { path: '/roundtrip.bin', data: bytes }, mockSocket);

      const iterable = await service.handle('readFileBinary', { path: '/roundtrip.bin', chunkSize: 200 }, mockSocket);
      const readBack = await collectBinary(iterable);
      expect(readBack).toEqual(bytes);
    });
  });

  describe('Unknown Methods', () => {
    it('should throw error for unknown method', async () => {
      await expect(
        service.handle('unknownMethod', {}, mockSocket)
      ).rejects.toMatchObject({
        code: ErrorCode.METHOD_NOT_FOUND,
        message: expect.stringContaining('Method not found'),
      });
    });
  });
});
