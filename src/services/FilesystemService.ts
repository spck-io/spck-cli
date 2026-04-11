/**
 * Filesystem service - handles file operations with fossil-delta compression
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import fossilDelta from 'fossil-delta';
import writeFileAtomic from 'write-file-atomic';
import { AuthenticatedSocket, ErrorCode, createRPCError } from '../types.js';
import { parseFileSize } from '../config/config.js';
import { logFsRead, logFsWrite } from '../utils/logger.js';

export class FilesystemService {
  private resolvedRootPath: string;
  private realRootPath: string | null = null;

  constructor(
    private rootPath: string,
    private config: any
  ) {
    // Resolve rootPath symlinks once during construction
    // This ensures consistent path comparisons in validatePath
    this.resolvedRootPath = path.resolve(rootPath);
  }

  /**
   * Get the real root path (following symlinks), cached after first call
   */
  private async getRealRootPath(): Promise<string> {
    if (!this.realRootPath) {
      this.realRootPath = await fs.realpath(this.rootPath);
    }
    return this.realRootPath;
  }

  /**
   * Handle filesystem RPC methods
   */
  async handle(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    const deviceId = socket.data.deviceId;
    let result: any;
    let error: any;

    try {
      // Validate and sandbox path
      const safePath = params.path ? await this.validatePath(params.path) : undefined;

      switch (method) {
        case 'exists':
          result = await this.exists(safePath!);
          logFsRead(method, params, deviceId, true);
          return result;
        case 'readFile':
          result = await this.readFile(safePath!, params);
          logFsRead(method, params, deviceId, true, undefined, { size: result.size, encoding: result.encoding });
          return result;
        case 'stat':
          result = await this.stat(safePath!);
          logFsRead(method, params, deviceId, true, undefined, { size: result.size });
          return result;
        case 'readFileBinary':
          result = await this.readFileBinary(safePath!, params);
          logFsRead(method, params, deviceId, true, undefined,
            result.rangeLength !== undefined
              ? { size: result.size, offset: result.rangeOffset, length: result.rangeLength }
              : { size: result.size, totalChunks: result.totalChunks }
          );
          return result;
        case 'writeBinary':
          result = await this.writeBinary(safePath!, params);
          logFsWrite(method, params, deviceId, true, undefined, { size: result.size });
          return result;
        case 'write':
          result = await this.write(safePath!, params);
          logFsWrite(method, params, deviceId, true, undefined, { size: result.size });
          return result;
        case 'patchFile':
          result = await this.patchFile(safePath!, params);
          logFsWrite(method, params, deviceId, true, undefined, { size: result.size });
          return result;
        case 'getFileHash':
          result = await this.getFileHash(safePath!);
          logFsRead(method, params, deviceId, true, undefined, { hash: result.hash });
          return result;
        case 'remove':
          result = await this.remove(safePath!);
          logFsWrite(method, params, deviceId, true);
          return result;
        case 'mkdir':
          result = await this.mkdir(safePath!, false);
          logFsWrite(method, params, deviceId, true);
          return result;
        case 'mkdirp':
          result = await this.mkdir(safePath!, true);
          logFsWrite(method, params, deviceId, true);
          return result;
        case 'readdir':
          result = await this.readdir(safePath!, params);
          logFsRead(method, params, deviceId, true, undefined, { count: result.entries.length });
          return result;
        case 'readdirDeep':
          result = await this.readdirDeep(safePath!, params);
          logFsRead(method, params, deviceId, true, undefined, { count: result.length });
          return result;
        case 'bulkExists':
          result = await this.bulkExists(safePath!, params);
          logFsRead(method, params, deviceId, true, undefined, { count: result.length });
          return result;
        case 'lstat':
          result = await this.lstat(safePath!);
          logFsRead(method, params, deviceId, true, undefined, { isFile: result.isFile, isDirectory: result.isDirectory });
          return result;
        case 'mv':
          result = await this.mv(await this.validatePath(params.src), await this.validatePath(params.target), params.opts);
          logFsWrite(method, params, deviceId, true, undefined, { type: result });
          return result;
        case 'copy':
          result = await this.copy(await this.validatePath(params.oldpath), safePath!, params.opts);
          logFsWrite(method, params, deviceId, true, undefined, { type: result });
          return result;
        case 'rmdir':
          result = await this.rmdir(safePath!);
          logFsWrite(method, params, deviceId, true);
          return result;
        default:
          throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: fs.${method}`);
      }
    } catch (err) {
      error = err;
      // Determine if this was a read or write operation for logging
      const readOps = ['exists', 'readFile', 'getFileHash', 'readdir', 'readdirDeep', 'bulkExists', 'lstat', 'stat'];
      if (readOps.includes(method)) {
        logFsRead(method, params, deviceId, false, error);
      } else {
        logFsWrite(method, params, deviceId, false, error);
      }
      throw error;
    }
  }

  /**
   * Validate and sandbox path with symlink resolution
   * Prevents directory traversal and symlink escape attacks
   */
  private async validatePath(userPath: string): Promise<string> {
    // Strip query string and fragment (cache-busters sent by the browser)
    const cleanPath = userPath.split('?')[0].split('#')[0];

    // Normalize path
    const normalized = path.normalize(cleanPath);

    // Prevent directory traversal
    if (normalized.includes('..')) {
      throw createRPCError(ErrorCode.INVALID_PATH, 'Invalid path: directory traversal not allowed');
    }

    // Resolve to absolute path
    const absolute = path.resolve(this.rootPath, normalized.startsWith('/') ? normalized.slice(1) : normalized);

    // Check if within root (before symlink resolution)
    if (!absolute.startsWith(this.resolvedRootPath)) {
      throw createRPCError(ErrorCode.INVALID_PATH, 'Access denied: path outside root directory');
    }

    // Resolve symlinks and verify they stay within root
    try {
      // Try to resolve the path (follows all symlinks including in rootPath)
      const realPath = await fs.realpath(absolute);

      // Get real root path (cached, in case rootPath itself contains symlinks like /tmp -> /private/tmp)
      const realRoot = await this.getRealRootPath();

      // Check resolved path is still within resolved root
      if (!realPath.startsWith(realRoot)) {
        throw createRPCError(
          ErrorCode.INVALID_PATH,
          'Access denied: symlink points outside root directory'
        );
      }

      return realPath;
    } catch (error: any) {
      // Path doesn't exist - validate parent directory instead
      if (error.code === 'ENOENT') {
        const parentDir = path.dirname(absolute);

        try {
          const parentReal = await fs.realpath(parentDir);
          const realRoot = await this.getRealRootPath();

          // Check parent directory is within root
          if (!parentReal.startsWith(realRoot)) {
            throw createRPCError(
              ErrorCode.INVALID_PATH,
              'Access denied: parent directory symlink points outside root'
            );
          }

          // Return original absolute path (not parent)
          return absolute;
        } catch (parentError: any) {
          // Parent doesn't exist either - allow for mkdirp operations
          // Just validate the normalized path structure
          return absolute;
        }
      }

      // Re-throw validation errors
      if (error.code === ErrorCode.INVALID_PATH) {
        throw error;
      }

      // For other errors, continue with original path
      return absolute;
    }
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
   * Check existence of multiple paths in parallel
   */
  private async bulkExists(basePath: string, params: any): Promise<number[]> {
    const { paths } = params;
    if (!Array.isArray(paths)) {
      throw createRPCError(ErrorCode.INVALID_PARAMS, 'paths must be an array');
    }

    // basePath is already validated/resolved by validatePath in handle()
    const realRoot = await this.getRealRootPath();

    // Validate and check all paths in parallel
    // Return 1/0 instead of true/false for bandwidth efficiency
    const results = await Promise.all(
      paths.map(async (relativePath: string) => {
        try {
          // Normalize relative path and prevent traversal
          const normalized = path.normalize(relativePath);
          if (normalized.includes('..')) return 0;

          // Resolve against validated base path
          const absolute = path.resolve(basePath, normalized);

          // Ensure still within root
          if (!absolute.startsWith(realRoot)) return 0;

          await fs.access(absolute);
          return 1;
        } catch {
          return 0;
        }
      })
    );

    return results;
  }

  /**
   * Read file contents
   */
  private async stat(safePath: string): Promise<any> {
    try {
      const stats = await fs.stat(safePath);
      return {
        size: stats.size,
        mtime: stats.mtimeMs,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw createRPCError(ErrorCode.FILE_NOT_FOUND, `File not found: ${safePath}`);
      }
      throw error;
    }
  }

  /**
   * Binary read — returns an async iterable of Buffer chunks.
   * ProxyClient detects the iterable and streams chunks to the client via __binaryChunk protocol.
   * File handle is opened once and held for the full iteration (atomic w.r.t. the file descriptor).
   */
  private async readFileBinary(safePath: string, params: any): Promise<any> {
    const CHUNK_SIZE = params.chunkSize || 750 * 1024;

    let stats: any;
    try {
      stats = await fs.stat(safePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw createRPCError(ErrorCode.FILE_NOT_FOUND, `File not found: ${safePath}`);
      }
      throw error;
    }

    const totalSize = stats.size;

    // Range read: single-chunk iterable for a specific byte range (used by video streaming)
    if (params.offset !== undefined) {
      const offset = params.offset as number;
      const rangeLength = Math.min(
        params.length !== undefined ? (params.length as number) : (totalSize - offset),
        totalSize - offset
      );
      if (offset < 0 || rangeLength < 0) {
        throw createRPCError(ErrorCode.INVALID_PARAMS, 'Invalid range parameters');
      }
      const iterable = {
        totalChunks: 1,
        size: totalSize,
        rangeOffset: offset,
        rangeLength,
        async *[Symbol.asyncIterator]() {
          const fh = await fs.open(safePath, 'r');
          try {
            const buf = Buffer.alloc(rangeLength);
            if (rangeLength > 0) await fh.read(buf, 0, rangeLength, offset);
            yield buf;
          } finally {
            await fh.close();
          }
        }
      };
      return iterable;
    }

    const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));

    // Return an async iterable. ProxyClient will detect [Symbol.asyncIterator] and stream chunks.
    const iterable = {
      totalChunks,
      size: totalSize,
      async *[Symbol.asyncIterator]() {
        const fh = await fs.open(safePath, 'r');
        try {
          for (let i = 0; i < totalChunks; i++) {
            const offset = i * CHUNK_SIZE;
            const length = Math.min(CHUNK_SIZE, totalSize - offset);
            const buf = Buffer.alloc(length);
            if (length > 0) await fh.read(buf, 0, length, offset);
            yield buf;
          }
        } finally {
          await fh.close();
        }
      }
    };
    return iterable;
  }

  /**
   * Binary write — receives the full buffer as a Socket.IO binary attachment.
   * No accumulation needed; ProxyClient routes directly once Socket.IO reassembles the binary.
   */
  private async writeBinary(safePath: string, params: any): Promise<any> {
    const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.alloc(0);
    return this.write(safePath, { ...params, contents: buffer, encoding: 'binary' });
  }

  private async readFile(safePath: string, params: any): Promise<any> {
    try {
      const stats = await fs.stat(safePath);

      const encoding = params.encoding || 'utf8';

      // Range read: bypass maxFileSize limit since we only read a small chunk
      if (params.offset !== undefined) {
        const offset = params.offset as number;
        const length = Math.min(
          params.length !== undefined ? (params.length as number) : (stats.size - offset),
          stats.size - offset
        );
        if (offset < 0 || length <= 0) {
          throw createRPCError(ErrorCode.INVALID_PARAMS, 'Invalid range parameters');
        }
        const fh = await fs.open(safePath, 'r');
        try {
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, offset);
          return { buffer: buf, size: stats.size, offset, length, encoding: 'binary' };
        } finally {
          await fh.close();
        }
      }

      // Check file size limit for full reads
      const maxSize = parseFileSize(this.config.maxFileSize);
      if (stats.size > maxSize) {
        throw createRPCError(
          ErrorCode.FILE_TOO_LARGE,
          `File too large: ${stats.size} bytes (max: ${this.config.maxFileSize})`,
          { size: stats.size, maxSize }
        );
      }

      if (encoding === 'binary') {
        // Binary file - return buffer directly in response
        const buffer = await fs.readFile(safePath);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

        return {
          buffer,
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
  private async write(safePath: string, params: any): Promise<any> {
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
      await writeFileAtomic(safePath, params.contents, { encoding });
    } else {
      await fs.writeFile(safePath, params.contents, encoding);
    }

    // Set executable if requested
    if (params.executable) {
      await fs.chmod(safePath, 0o755);
    }

    // Return metadata
    const stats = await fs.stat(safePath);

    // Check total file size after write to prevent bypass via multiple writes
    const maxSize = parseFileSize(this.config.maxFileSize);
    if (stats.size > maxSize) {
      // Rollback: delete the oversized file
      try {
        await fs.unlink(safePath);
      } catch (unlinkError) {
        // Ignore unlink errors (file might be locked)
      }

      throw createRPCError(
        ErrorCode.FILE_TOO_LARGE,
        `File exceeds maximum size after write: ${stats.size} bytes (max: ${this.config.maxFileSize})`,
        { size: stats.size, maxSize }
      );
    }

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
    if (hash === null) {
      return { hash: null, size: 0, mtime: 0 };
    }
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

      const ignoreSet = new Set<string>(['.git', '.spck-editor', '.DS_Store']);
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
   * Read directory recursively using breadth-first (level-order) traversal
   * Performance optimizations:
   * - matchPattern: Regex to filter paths (applied to full relative path)
   * - limit: Maximum number of results (files + folders combined)
   *
   * Breadth-first ensures top-level items are returned first, which is important
   * when using the limit parameter to get a representative sample of the directory.
   */
  private async readdirDeep(safePath: string, params: any): Promise<any> {
    try {
      const includeFiles = params.files !== false;  // Default true
      const includeFolders = params.folders !== false;  // Default true
      const limit = params.limit !== undefined && params.limit !== null
        ? parseInt(params.limit, 10)
        : null;

      // Compile regex pattern if provided (case-insensitive)
      let matchRegex: RegExp | null = null;
      if (params.matchPattern) {
        try {
          matchRegex = new RegExp(params.matchPattern, 'i');
        } catch (error: any) {
          throw createRPCError(ErrorCode.INVALID_PARAMS, `Invalid matchPattern regex: ${error.message}`);
        }
      }

      // Parse ignoreName into a Set
      const ignoreSet = new Set<string>(['.git', '.spck-editor']);
      if (params.ignoreName && typeof params.ignoreName === 'string') {
        params.ignoreName.split(':').forEach((name: string) => {
          if (name.trim()) {
            ignoreSet.add(name.trim());
          }
        });
      }

      const results: string[] = [];

      // Early exit if limit is 0
      if (limit === 0) {
        return [];
      }

      // Verify initial directory exists before starting traversal
      try {
        const stats = await fs.stat(safePath);
        if (!stats.isDirectory()) {
          throw createRPCError(ErrorCode.FILE_NOT_FOUND, `Not a directory: ${safePath}`);
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          throw createRPCError(ErrorCode.FILE_NOT_FOUND, `Directory not found: ${safePath}`);
        }
        throw error;
      }

      // Get real root path for relative path calculations
      // (safePath might be resolved real path if it was a symlink)
      const realRoot = await this.getRealRootPath();

      // Breadth-first traversal using a queue
      let queue: string[] = [safePath];

      while (queue.length > 0 && (limit === null || results.length < limit)) {
        // Process current level
        const currentLevel = queue;
        queue = [];  // New queue for next level

        for (const currentPath of currentLevel) {
          // Early exit if limit reached
          if (limit !== null && results.length >= limit) {
            break;
          }

          let entries: string[];
          try {
            entries = await fs.readdir(currentPath);
          } catch (error: any) {
            // Skip subdirectories we can't read (but initial dir should have been validated)
            continue;
          }

          for (const name of entries) {
            // Early exit if limit reached
            if (limit !== null && results.length >= limit) {
              break;
            }

            // Skip ignored names
            if (ignoreSet.has(name)) {
              continue;
            }

            const entryPath = path.join(currentPath, name);
            let stats;
            try {
              stats = await fs.stat(entryPath);
            } catch (error: any) {
              // Skip entries we can't stat
              continue;
            }

            if (stats.isDirectory()) {
              // Add to next level queue
              queue.push(entryPath);

              // Convert to relative path using real root
              const outputPath = path.relative(realRoot, entryPath);

              // Apply filter and check limit for folders
              if (includeFolders) {
                const matches = !matchRegex || matchRegex.test(outputPath);
                if (matches) {
                  results.push(outputPath);
                }
              }
            } else if (stats.isFile() && includeFiles) {
              // Convert to relative path using real root
              const outputPath = path.relative(realRoot, entryPath);

              // Apply filter and check limit for files
              const matches = !matchRegex || matchRegex.test(outputPath);
              if (matches) {
                results.push(outputPath);
              }
            }
          }
        }
      }

      return results;
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
