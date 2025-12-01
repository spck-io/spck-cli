/**
 * Filesystem service - handles file operations with fossil-delta compression
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fossilDelta from 'fossil-delta';
import writeFileAtomic from 'write-file-atomic';
import { AuthenticatedSocket, ErrorCode, createRPCError } from '../types';
import { parseFileSize } from '../config/config';
import { logFsRead, logFsWrite } from '../utils/logger';

export class FilesystemService {
  constructor(
    private rootPath: string,
    private config: any
  ) {}

  /**
   * Handle filesystem RPC methods
   */
  async handle(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    const uid = socket.data?.uid || 'unknown';
    let result: any;
    let error: any;

    try {
      // Validate and sandbox path
      const safePath = params.path ? this.validatePath(params.path) : undefined;

      switch (method) {
        case 'exists':
          result = await this.exists(safePath!);
          logFsRead(method, params, uid, true);
          return result;
        case 'readFile':
          result = await this.readFile(safePath!, params, socket);
          logFsRead(method, params, uid, true, undefined, { size: result.size, encoding: result.encoding });
          return result;
        case 'write':
          result = await this.write(safePath!, params, socket);
          logFsWrite(method, params, uid, true, undefined, { size: result.size });
          return result;
        case 'patchFile':
          result = await this.patchFile(safePath!, params);
          logFsWrite(method, params, uid, true, undefined, { size: result.size });
          return result;
        case 'getFileHash':
          result = await this.getFileHash(safePath!);
          logFsRead(method, params, uid, true, undefined, { hash: result.hash });
          return result;
        case 'remove':
          result = await this.remove(safePath!);
          logFsWrite(method, params, uid, true);
          return result;
        case 'mkdir':
          result = await this.mkdir(safePath!, false);
          logFsWrite(method, params, uid, true);
          return result;
        case 'mkdirp':
          result = await this.mkdir(safePath!, true);
          logFsWrite(method, params, uid, true);
          return result;
        case 'readdir':
          result = await this.readdir(safePath!, params);
          logFsRead(method, params, uid, true, undefined, { count: result.entries.length });
          return result;
        case 'readdirDeep':
          result = await this.readdirDeep(safePath!, params);
          logFsRead(method, params, uid, true, undefined, { files: result.files.length, folders: result.folders.length });
          return result;
        case 'lstat':
          result = await this.lstat(safePath!);
          logFsRead(method, params, uid, true, undefined, { isFile: result.isFile, isDirectory: result.isDirectory });
          return result;
        case 'mv':
          result = await this.mv(this.validatePath(params.src), this.validatePath(params.target), params.opts);
          logFsWrite(method, params, uid, true, undefined, { type: result });
          return result;
        case 'copy':
          result = await this.copy(this.validatePath(params.oldpath), safePath!, params.opts);
          logFsWrite(method, params, uid, true, undefined, { type: result });
          return result;
        case 'rmdir':
          result = await this.rmdir(safePath!);
          logFsWrite(method, params, uid, true);
          return result;
        default:
          throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: fs.${method}`);
      }
    } catch (err) {
      error = err;
      // Determine if this was a read or write operation for logging
      const readOps = ['exists', 'readFile', 'getFileHash', 'readdir', 'readdirDeep', 'lstat'];
      if (readOps.includes(method)) {
        logFsRead(method, params, uid, false, error);
      } else {
        logFsWrite(method, params, uid, false, error);
      }
      throw error;
    }
  }

  /**
   * Validate and sandbox path
   */
  private validatePath(userPath: string): string {
    // Normalize path
    const normalized = path.normalize(userPath);

    // Prevent directory traversal
    if (normalized.includes('..')) {
      throw createRPCError(ErrorCode.INVALID_PATH, 'Invalid path: directory traversal not allowed');
    }

    // Resolve to absolute path
    const absolute = path.resolve(this.rootPath, normalized.startsWith('/') ? normalized.slice(1) : normalized);

    // Check if within root
    if (!absolute.startsWith(path.resolve(this.rootPath))) {
      throw createRPCError(ErrorCode.INVALID_PATH, 'Access denied: path outside root directory');
    }

    // Allow .spck-editor/.tmp and .spck-editor/.trash, but block other .spck-editor paths
    if (normalized.includes('.spck-editor')) {
      const allowedPaths = ['.spck-editor/.tmp', '.spck-editor/.trash'];
      const isAllowed = allowedPaths.some(allowed => normalized.includes(allowed));

      if (!isAllowed) {
        throw createRPCError(
          ErrorCode.INVALID_PATH,
          `Access denied: hidden directory (path: ${normalized})`
        );
      }
    }

    return absolute;
  }

  /**
   * Check if file/directory exists
   */
  private async exists(safePath: string): Promise<{ exists: boolean }> {
    try {
      await fs.access(safePath);
      return { exists: true };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Read file contents
   */
  private async readFile(safePath: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    try {
      const stats = await fs.stat(safePath);

      // Check file size limit
      const maxSize = parseFileSize(this.config.maxFileSize);
      if (stats.size > maxSize) {
        throw createRPCError(
          ErrorCode.FILE_TOO_LARGE,
          `File too large: ${stats.size} bytes (max: ${this.config.maxFileSize})`,
          { size: stats.size, maxSize }
        );
      }

      const encoding = params.encoding || 'utf8';

      if (encoding === 'binary') {
        // Binary file - send via rpc:binary
        const buffer = await fs.readFile(safePath);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

        // Send binary data
        socket.emit('rpc:binary', {
          id: params.requestId,
          buffer,
        });

        return {
          size: stats.size,
          mtime: stats.mtimeMs,
          encoding: 'binary',
          sha256,
        };
      } else {
        // Text file
        const contents = await fs.readFile(safePath, encoding);
        const contentsStr = typeof contents === 'string' ? contents : contents.toString('utf8');
        const sha256 = crypto.createHash('sha256').update(contentsStr, 'utf8').digest('hex');

        return {
          contents,
          size: stats.size,
          mtime: stats.mtimeMs,
          encoding,
          sha256,
        };
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw createRPCError(ErrorCode.FILE_NOT_FOUND, `File not found: ${safePath}`);
      }
      throw error;
    }
  }

  /**
   * Write file contents
   */
  private async write(safePath: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    // Check if expectedHash provided (conflict detection)
    if (params.expectedHash) {
      const currentHash = await this.getFileHashValue(safePath);
      if (currentHash && currentHash !== params.expectedHash) {
        throw createRPCError(
          ErrorCode.WRITE_CONFLICT,
          'File was modified on server since last read',
          {
            expectedHash: params.expectedHash,
            currentHash,
          }
        );
      }
    }

    const encoding = params.encoding || 'utf8';
    const atomic = params.atomic || false;

    // Write file (atomic or regular)
    if (atomic) {
      // Use write-file-atomic for atomic writes
      if (encoding === 'binary') {
        await writeFileAtomic(safePath, params.contents || Buffer.alloc(0));
      } else {
        await writeFileAtomic(safePath, params.contents, { encoding });
      }
    } else {
      // Regular write
      if (encoding === 'binary') {
        await fs.writeFile(safePath, params.contents || Buffer.alloc(0));
      } else {
        await fs.writeFile(safePath, params.contents, encoding);
      }
    }

    // Set executable if requested
    if (params.executable) {
      await fs.chmod(safePath, 0o755);
    }

    // Return metadata
    const stats = await fs.stat(safePath);
    const contents = await fs.readFile(safePath);
    const sha256 = crypto.createHash('sha256').update(contents).digest('hex');

    return {
      success: true,
      mtime: stats.mtimeMs,
      size: stats.size,
      sha256,
    };
  }

  /**
   * Apply fossil-delta patch to file
   */
  private async patchFile(safePath: string, params: any): Promise<any> {
    try {
      // Read current file
      const currentContents = await fs.readFile(safePath);

      // Verify base hash
      const currentHash = crypto.createHash('sha256').update(currentContents).digest('hex');
      if (currentHash !== params.baseHash) {
        throw createRPCError(
          ErrorCode.WRITE_CONFLICT,
          'Base hash mismatch - file was modified',
          {
            expectedHash: params.baseHash,
            currentHash,
          }
        );
      }

      // Apply fossil-delta patch
      const deltaBuffer = Buffer.from(params.delta);
      const patchedResult = fossilDelta.apply(currentContents, deltaBuffer);

      // Convert to Buffer if it's an array
      const patchedContents = Buffer.isBuffer(patchedResult)
        ? patchedResult
        : Buffer.from(patchedResult);

      // Verify final hash
      const finalHash = crypto.createHash('sha256').update(patchedContents).digest('hex');

      // Check if delta resulted in expected content (80% efficiency check happens client-side)
      if (params.newHash && finalHash !== params.newHash) {
        throw createRPCError(
          ErrorCode.DELTA_PATCH_FAILED,
          'Final hash mismatch - patch resulted in unexpected content',
          {
            expectedHash: params.newHash,
            actualHash: finalHash,
          }
        );
      }

      // Write file (atomic or regular)
      const atomic = params.atomic || false;
      const encoding = params.encoding || 'utf8';

      if (atomic) {
        await writeFileAtomic(safePath, patchedContents, { encoding });
      } else {
        await fs.writeFile(safePath, patchedContents, encoding);
      }

      // Return metadata
      const stats = await fs.stat(safePath);
      return {
        success: true,
        finalHash,
        size: stats.size,
        mtime: stats.mtimeMs,
      };
    } catch (error: any) {
      if (error.code && error.message) {
        throw error; // Re-throw RPC errors
      }
      throw createRPCError(
        ErrorCode.DELTA_PATCH_FAILED,
        `Failed to apply delta patch: ${error.message}`,
        { reason: error.toString() }
      );
    }
  }

  /**
   * Get file hash
   */
  private async getFileHash(safePath: string): Promise<any> {
    const hash = await this.getFileHashValue(safePath);
    const stats = await fs.stat(safePath);

    return {
      hash,
      size: stats.size,
      mtime: stats.mtimeMs,
    };
  }

  /**
   * Get file hash value (internal)
   */
  private async getFileHashValue(safePath: string): Promise<string | null> {
    try {
      const contents = await fs.readFile(safePath);
      return crypto.createHash('sha256').update(contents).digest('hex');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Remove file or directory
   * Returns success even if file doesn't exist (idempotent operation)
   */
  private async remove(safePath: string): Promise<{ success: boolean }> {
    try {
      const stats = await fs.stat(safePath);
      if (stats.isDirectory()) {
        await fs.rm(safePath, { recursive: true, force: true });
      } else {
        await fs.unlink(safePath);
      }
      return { success: true };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist - treat as already removed (idempotent)
        return { success: true };
      }
      throw error;
    }
  }

  /**
   * Create directory
   */
  private async mkdir(safePath: string, recursive: boolean): Promise<{ success: boolean }> {
    await fs.mkdir(safePath, { recursive });
    return { success: true };
  }

  /**
   * Read directory contents
   */
  private async readdir(safePath: string, params: any): Promise<any> {
    try {
      const entries = await fs.readdir(safePath);
      const result = [];

      const ignoreSet = new Set<string>(['.git', '.spck-editor']);
      for (const name of entries) {
        if (ignoreSet.has(name)) continue;

        const entryPath = path.join(safePath, name);
        const stats = await fs.stat(entryPath);

        // Skip based on filters
        if (params.skipFiles && stats.isFile()) continue;
        else if (params.skipFolders && stats.isDirectory()) continue;

        // Return just the name string, not the object
        result.push(name);
      }

      return { entries: result };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw createRPCError(ErrorCode.FILE_NOT_FOUND, `Directory not found: ${safePath}`);
      }
      throw error;
    }
  }

  /**
   * Read directory recursively
   */
  private async readdirDeep(safePath: string, params: any): Promise<any> {
    try {
      const includeFiles = params.files !== false;  // Default true
      const includeFolders = params.folders !== false;  // Default true

      // Parse ignoreName into a Set
      const ignoreSet = new Set<string>(['.git', '.spck-editor']);
      if (params.ignoreName && typeof params.ignoreName === 'string') {
        params.ignoreName.split(':').forEach((name: string) => {
          if (name.trim()) {
            ignoreSet.add(name.trim());
          }
        });
      }

      const files: string[] = [];
      const folders: string[] = [];

      // Recursive helper function
      const walk = async (currentPath: string) => {
        const entries = await fs.readdir(currentPath);

        for (const name of entries) {
          // Skip ignored names
          if (ignoreSet.has(name)) {
            continue;
          }

          const entryPath = path.join(currentPath, name);
          const stats = await fs.stat(entryPath);

          if (stats.isDirectory()) {
            if (includeFolders) {
              folders.push(entryPath);
            }
            // Recurse into subdirectory
            await walk(entryPath);
          } else if (stats.isFile() && includeFiles) {
            files.push(entryPath);
          }
        }
      };

      await walk(safePath);

      return { files, folders };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw createRPCError(ErrorCode.FILE_NOT_FOUND, `Directory not found: ${safePath}`);
      }
      throw error;
    }
  }

  /**
   * Get file metadata
   */
  private async lstat(safePath: string): Promise<any> {
    try {
      const stats = await fs.lstat(safePath);
      return {
        mode: stats.mode,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        atimeMs: stats.atimeMs,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: stats.isSymbolicLink(),
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw createRPCError(ErrorCode.FILE_NOT_FOUND, `File not found: ${safePath}`);
      }
      throw error;
    }
  }

  /**
   * Move/rename file or directory
   * Returns the type of the moved item ('file' or 'folder')
   */
  private async mv(srcPath: string, targetPath: string, opts: any = {}): Promise<string> {
    try {
      // Check source type before moving
      const srcStats = await fs.stat(srcPath);
      const type = srcStats.isDirectory() ? 'folder' : 'file';

      // Ensure target directory exists
      const targetDir = path.dirname(targetPath);
      try {
        await fs.access(targetDir);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // Create target directory if it doesn't exist
          await fs.mkdir(targetDir, { recursive: true });
        }
      }

      // Check if target exists
      if (!opts.overwrite) {
        try {
          await fs.access(targetPath);
          throw createRPCError(
            ErrorCode.INVALID_PATH,
            'Target already exists and overwrite is false'
          );
        } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
        }
      }

      await fs.rename(srcPath, targetPath);
      return type;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // If this is a deletion (move to trash) and source doesn't exist, treat as already deleted
        if (opts.deletion) {
          return 'file'; // Return default type for deleted files
        }
        throw createRPCError(
          ErrorCode.FILE_NOT_FOUND,
          `Source file not found: ${srcPath} (attempting to move to ${targetPath})`
        );
      }
      throw error;
    }
  }

  /**
   * Copy file or directory
   * Returns the type of the copied item ('file' or 'folder')
   */
  private async copy(oldPath: string, newPath: string, opts: any = {}): Promise<string> {
    try {
      // Check source type before copying
      const srcStats = await fs.stat(oldPath);
      const type = srcStats.isDirectory() ? 'folder' : 'file';

      if (srcStats.isDirectory()) {
        // Copy directory recursively
        await this.copyDirectory(oldPath, newPath, opts);
      } else {
        // Copy file
        const flags = opts.overwrite ? 0 : fsSync.constants.COPYFILE_EXCL;
        await fs.copyFile(oldPath, newPath, flags);
      }

      return type;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw createRPCError(ErrorCode.FILE_NOT_FOUND, `Source file not found: ${oldPath}`);
      }
      if (error.code === 'EEXIST') {
        throw createRPCError(
          ErrorCode.INVALID_PATH,
          'Target already exists and overwrite is false'
        );
      }
      throw error;
    }
  }

  /**
   * Copy directory recursively (helper method)
   */
  private async copyDirectory(srcDir: string, destDir: string, opts: any = {}): Promise<void> {
    // Create destination directory
    await fs.mkdir(destDir, { recursive: true });

    // Read source directory
    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        // Recursively copy subdirectory
        await this.copyDirectory(srcPath, destPath, opts);
      } else {
        // Copy file
        const flags = opts.overwrite ? 0 : fsSync.constants.COPYFILE_EXCL;
        await fs.copyFile(srcPath, destPath, flags);
      }
    }
  }

  /**
   * Remove directory
   * Returns success even if directory doesn't exist (idempotent operation)
   */
  private async rmdir(safePath: string): Promise<{ success: boolean }> {
    try {
      await fs.rmdir(safePath);
      return { success: true };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Directory doesn't exist - treat as already removed (idempotent)
        return { success: true };
      }
      throw error;
    }
  }
}
