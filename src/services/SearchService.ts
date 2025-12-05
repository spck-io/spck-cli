/**
 * Search service - efficient server-side text search
 *
 * Design principles:
 * - Stream-based processing to handle large files efficiently
 * - Buffer-based searching for performance
 * - Cross-platform compatible (no shell commands)
 * - Memory-efficient with configurable limits
 */

import * as fs from 'fs';
import * as path from 'path';
import { ErrorCode, createRPCError, AuthenticatedSocket } from '../types';
import { logSearchRead } from '../utils/logger';

interface SearchParams {
  path: string;
  maxMatchPerFile: number;
  maxLength: number;
  searchTerm: string;
  matchCase: boolean;
  useRegEx: boolean;
  onlyWholeWords: boolean;
}

interface SearchResult {
  start: { row: number; column: number };
  end: { row: number; column: number };
  range: { start: number; end: number };
  line: string;
  value: string;
  match: { start: number; end: number };
  path: string;
}

export class SearchService {
  private maxFileSize: number;
  private chunkSize: number;

  constructor(
    private rootPath: string = process.cwd(),
    maxFileSize: number = 10 * 1024 * 1024, // 10MB default
    chunkSize: number = 64 * 1024 // 64KB chunks
  ) {
    this.maxFileSize = maxFileSize;
    this.chunkSize = chunkSize;
  }

  /**
   * Handle search RPC methods
   */
  async handle(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    switch (method) {
      case 'findInFile':
        return await this.findInFile(params, socket);
      default:
        throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: search.${method}`);
    }
  }

  /**
   * Find matches in a file
   */
  private async findInFile(params: SearchParams, socket: AuthenticatedSocket): Promise<SearchResult[] | null> {
    const { path: relativePath, maxMatchPerFile, maxLength, searchTerm, matchCase, useRegEx, onlyWholeWords } = params;
    const uid = socket.data.uid;
    let searchMethod: string | undefined;
    let fileSize: number | undefined;

    try {
      // Validate path is within root
      const absolutePath = path.resolve(this.rootPath, relativePath);
      if (!absolutePath.startsWith(this.rootPath)) {
        throw createRPCError(ErrorCode.PERMISSION_DENIED, 'Access denied: path outside root');
      }

      // Check file exists and is readable
      try {
        const stats = await fs.promises.stat(absolutePath);
        fileSize = stats.size;

        // Skip directories
        if (stats.isDirectory()) {
          logSearchRead('findInFile', params, uid, true, undefined, { matches: 0, method: 'skipped-dir' });
          return null;
        }

        // Skip files that are too large
        if (stats.size > this.maxFileSize) {
          logSearchRead('findInFile', params, uid, true, undefined, { matches: 0, method: 'skipped-large' });
          return null;
        }

        // Skip empty files
        if (stats.size === 0) {
          logSearchRead('findInFile', params, uid, true, undefined, { matches: 0, method: 'skipped-empty' });
          return null;
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          logSearchRead('findInFile', params, uid, true, undefined, { matches: 0, method: 'not-found' });
          return null;
        }
        throw createRPCError(ErrorCode.INTERNAL_ERROR, `Failed to stat file: ${error.message}`);
      }

      // Build regex pattern
      const regex = this.buildRegExp(searchTerm, useRegEx, matchCase, onlyWholeWords);

      // For small files, read entirely for better performance
      const stats = await fs.promises.stat(absolutePath);
      let results: SearchResult[] | null;
      if (stats.size < this.chunkSize * 2) {
        searchMethod = 'full-read';
        results = await this.searchSmallFile(absolutePath, relativePath, regex, maxMatchPerFile, maxLength);
      } else {
        searchMethod = 'streaming';
        results = await this.searchLargeFile(absolutePath, relativePath, regex, maxMatchPerFile, maxLength);
      }

      // Log success
      const matches = results?.length || 0;
      logSearchRead('findInFile', params, uid, true, undefined, {
        matches,
        method: searchMethod,
        size: fileSize
      });

      return results;
    } catch (error: any) {
      // Log error
      logSearchRead('findInFile', params, uid, false, error, { method: searchMethod, size: fileSize });
      throw error;
    }
  }

  /**
   * Build regular expression from search parameters
   */
  private buildRegExp(pattern: string, useRegEx: boolean, matchCase: boolean, onlyWholeWords: boolean): RegExp {
    // Escape special regex characters if not using regex mode
    if (!useRegEx) {
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Add word boundary markers if matching whole words
    if (onlyWholeWords) {
      pattern = '\\b' + pattern + '\\b';
    }

    const flags = matchCase ? 'gm' : 'igm';
    return new RegExp(pattern, flags);
  }

  /**
   * Search small files by reading entirely into memory
   */
  private async searchSmallFile(
    absolutePath: string,
    relativePath: string,
    regex: RegExp,
    maxMatchPerFile: number,
    maxLength: number
  ): Promise<SearchResult[] | null> {
    let text: string;

    try {
      text = await fs.promises.readFile(absolutePath, 'utf8');
    } catch (error: any) {
      // If not valid UTF-8, skip this file
      if (error.message?.includes('invalid') || error.message?.includes('encoding')) {
        return null;
      }
      throw createRPCError(ErrorCode.INTERNAL_ERROR, `Failed to read file: ${error.message}`);
    }

    const results: SearchResult[] = [];
    let match: RegExpExecArray | null;

    for (let i = 0; i < maxMatchPerFile; i++) {
      match = regex.exec(text);
      if (!match) {
        break;
      }

      const range = this.getSurroundingLineRange(text, match.index, match[0].length, maxLength);
      results.push({
        start: this.indexToPosition(text, match.index),
        end: this.indexToPosition(text, regex.lastIndex),
        range,
        line: text.slice(range.start, range.end),
        value: match[0],
        match: {
          start: match.index - range.start,
          end: regex.lastIndex - range.start,
        },
        path: relativePath,
      });
    }

    return results.length > 0 ? results : null;
  }

  /**
   * Search large files using streaming approach
   * This handles files that might not fit in memory
   */
  private async searchLargeFile(
    absolutePath: string,
    relativePath: string,
    regex: RegExp,
    maxMatchPerFile: number,
    maxLength: number
  ): Promise<SearchResult[] | null> {
    const stream = fs.createReadStream(absolutePath, {
      encoding: 'utf8',
      highWaterMark: this.chunkSize,
    });

    let buffer = '';
    let offset = 0;
    const results: SearchResult[] = [];
    const overlapSize = Math.max(maxLength * 2, 1024); // Overlap to catch matches at chunk boundaries

    try {
      for await (const chunk of stream) {
        buffer += chunk;

        // Search in current buffer
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(buffer)) !== null && results.length < maxMatchPerFile) {
          const absoluteIndex = offset + match.index;

          // Build result
          const range = this.getSurroundingLineRange(buffer, match.index, match[0].length, maxLength);
          const lineText = buffer.slice(range.start, range.end);

          results.push({
            start: this.indexToPosition(buffer.slice(0, offset + buffer.length), absoluteIndex),
            end: this.indexToPosition(buffer.slice(0, offset + buffer.length), absoluteIndex + match[0].length),
            range: {
              start: offset + range.start,
              end: offset + range.end,
            },
            line: lineText,
            value: match[0],
            match: {
              start: match.index - range.start,
              end: regex.lastIndex - range.start,
            },
            path: relativePath,
          });

          if (results.length >= maxMatchPerFile) {
            stream.destroy();
            break;
          }
        }

        if (results.length >= maxMatchPerFile) {
          break;
        }

        // Keep overlap for next chunk to catch matches at boundaries
        if (buffer.length > overlapSize) {
          offset += buffer.length - overlapSize;
          buffer = buffer.slice(-overlapSize);
        }
      }
    } catch (error: any) {
      // Handle encoding errors gracefully
      if (error.message?.includes('invalid') || error.message?.includes('encoding')) {
        return null;
      }
      throw createRPCError(ErrorCode.INTERNAL_ERROR, `Failed to search file: ${error.message}`);
    }

    return results.length > 0 ? results : null;
  }

  /**
   * Get surrounding line range for context
   */
  private getSurroundingLineRange(
    source: string,
    index: number,
    matchLength: number,
    maxLength: number
  ): { start: number; end: number } {
    maxLength = maxLength || 10000;
    maxLength = maxLength > matchLength ? maxLength - matchLength : 0;

    const indexEnd = index + matchLength;
    let before = source.slice(Math.max(index - maxLength, 0), index);
    let after = source.slice(indexEnd, indexEnd + maxLength);

    // Trim to line boundaries
    const beforeLines = before.split(/[\n\r]/);
    before = beforeLines[beforeLines.length - 1] || '';
    before = before.replace(/^\s+/, '');

    const afterLines = after.split(/[\n\r]/);
    after = afterLines[0] || '';
    after = after.replace(/\s+$/, '');

    // Truncate if too long
    if (before.length + after.length > maxLength) {
      before = before.slice(Math.max(0, before.length - Math.floor(maxLength / 2)));
      after = after.slice(0, maxLength - before.length);
    }

    return {
      start: index - before.length,
      end: indexEnd + after.length,
    };
  }

  /**
   * Convert string index to row/column position
   */
  private indexToPosition(str: string, index: number): { row: number; column: number } {
    const beforeMatch = str.slice(0, index);
    const lines = beforeMatch.split(/\r\n|\r|\n/g);
    return {
      row: lines.length - 1,
      column: lines[lines.length - 1]?.length || 0,
    };
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // No persistent resources to clean up
  }
}
