/**
 * Search service - efficient server-side text search
 *
 * Design principles:
 * - Use ripgrep when available for maximum performance
 * - Stream-based processing to handle large files efficiently
 * - Buffer-based searching for performance
 * - Cross-platform compatible
 * - Memory-efficient with configurable limits
 */

import * as fs from 'fs';
import * as path from 'path';
import { ErrorCode, createRPCError, AuthenticatedSocket } from '../types.js';
import { logSearchRead } from '../utils/logger.js';
import { isRipgrepAvailable, executeRipgrep, executeRipgrepStream } from '../utils/ripgrep.js';

interface StreamSearchParams {
  glob: string;
  rootDir?: string;
  maxResults: number;
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
  private ripgrepAvailable: boolean | null = null;

  constructor(
    private rootPath: string = process.cwd(),
    maxFileSize: number = 10 * 1024 * 1024, // 10MB default
    chunkSize: number = 64 * 1024 // 64KB chunks
  ) {
    this.maxFileSize = maxFileSize;
    this.chunkSize = chunkSize;

    // Check ripgrep availability on initialization
    this.checkRipgrepAvailability();
  }

  /**
   * Check if ripgrep is available (async, caches result)
   */
  private async checkRipgrepAvailability(): Promise<void> {
    if (this.ripgrepAvailable === null) {
      this.ripgrepAvailable = await isRipgrepAvailable();
    }
  }

  /**
   * Check if character is a word boundary (space or punctuation)
   */
  private isWordBoundary(char: string): boolean {
    return /[\W]/.test(char);
  }

  /**
   * Find word boundary going backwards from position
   */
  private findWordBoundaryBackward(text: string, pos: number): number {
    if (pos <= 0) return 0;

    // Move back to find a word boundary
    for (let i = pos; i >= 0; i--) {
      if (this.isWordBoundary(text[i])) {
        // Return position after the boundary character
        return i + 1;
      }
    }
    return 0;
  }

  /**
   * Find word boundary going forward from position
   */
  private findWordBoundaryForward(text: string, pos: number): number {
    if (pos >= text.length) return text.length;

    // Move forward to find a word boundary
    for (let i = pos; i < text.length; i++) {
      if (this.isWordBoundary(text[i])) {
        // Return position of the boundary character
        return i;
      }
    }
    return text.length;
  }

  /**
   * Trim line text to show context around match
   * - Trims to word boundaries
   * - Adds "…" prefix/suffix if trimmed
   * - Returns trimmed line and offset
   */
  private trimLineToMatch(lineText: string, matchStart: number, matchEnd: number, maxLength: number): { line: string; offset: number } {
    // Default maxLength if not provided or invalid
    if (!maxLength || maxLength <= 0) {
      maxLength = 500;
    }

    // Ensure valid match positions
    if (matchStart < 0 || matchEnd > lineText.length || matchStart >= matchEnd) {
      return { line: lineText, offset: 0 };
    }

    // If line is short enough, return as-is
    if (lineText.length <= maxLength) {
      return { line: lineText, offset: 0 };
    }

    const matchLength = matchEnd - matchStart;

    // If match itself is longer than maxLength, just show the start of the match
    if (matchLength >= maxLength) {
      const trimmed = lineText.substring(matchStart, matchStart + maxLength);
      return {
        line: trimmed,
        offset: matchStart
      };
    }

    // Calculate initial context on each side
    const contextPerSide = Math.floor((maxLength - matchLength) / 2);

    // Initial positions
    let start = Math.max(0, matchStart - contextPerSide);
    let end = Math.min(lineText.length, matchEnd + contextPerSide);

    // Adjust to word boundaries
    if (start > 0) {
      const wordStart = this.findWordBoundaryBackward(lineText, start);
      // Only use word boundary if it doesn't shrink the context too much
      if (matchStart - wordStart >= contextPerSide * 0.5) {
        start = wordStart;
      }
    }

    if (end < lineText.length) {
      const wordEnd = this.findWordBoundaryForward(lineText, end);
      // Only use word boundary if it doesn't shrink the context too much
      if (wordEnd - matchEnd >= contextPerSide * 0.5) {
        end = wordEnd;
      }
    }

    // Try to extend to include more complete words if we have room
    let currentLength = end - start;

    // Extend backward
    while (start > 0 && currentLength < maxLength) {
      const prevBoundary = this.findWordBoundaryBackward(lineText, start - 1);

      // Break if we didn't move (no progress)
      if (prevBoundary >= start) break;

      const newLength = end - prevBoundary;

      // Don't extend if it would exceed maxLength
      if (newLength > maxLength) break;

      start = prevBoundary;
      currentLength = newLength;

      if (currentLength >= maxLength) break;
    }

    // Extend forward
    while (end < lineText.length && currentLength < maxLength) {
      const nextBoundary = this.findWordBoundaryForward(lineText, end + 1);

      // Break if we didn't move (no progress)
      if (nextBoundary <= end) break;

      const newLength = nextBoundary - start;

      // Don't extend if it would exceed maxLength
      if (newLength > maxLength) break;

      end = nextBoundary;
      currentLength = newLength;

      if (currentLength >= maxLength) break;
    }

    // Build result with ellipsis
    let result = lineText.substring(start, end);
    let adjustedOffset = start;

    // Add leading ellipsis if not at start
    if (start > 0) {
      result = '…' + result;
      // Adjust offset to account for the leading ellipsis
      adjustedOffset = start - 1;
    }

    // Add trailing ellipsis if not at end
    if (end < lineText.length) {
      result = result + '…';
    }

    // Final check: ensure result doesn't exceed maxLength
    // This can happen when ellipsis are added
    if (result.length > maxLength) {
      // Trim from the end, preserving the match
      const hasLeadingEllipsis = start > 0;
      const hasTrailingEllipsis = end < lineText.length;

      // Calculate how much to trim
      const excess = result.length - maxLength;

      // Remove trailing ellipsis temporarily if present
      if (hasTrailingEllipsis) {
        result = result.slice(0, -1);
      }

      // Trim the excess from the end
      result = result.slice(0, result.length - excess);

      // Re-add trailing ellipsis if it was there
      if (hasTrailingEllipsis) {
        result = result + '…';
      }
    }

    return {
      line: result,
      offset: adjustedOffset
    };
  }

  /**
   * Stream search results using ripgrep with glob patterns
   * Falls back to Node.js implementation if ripgrep is not available
   * Sends results in batches of 50 via RPC notifications
   */
  private async findWithStream(params: StreamSearchParams, socket: AuthenticatedSocket): Promise<void> {
    const { glob, maxLength, maxResults, searchTerm, matchCase, useRegEx, onlyWholeWords } = params;
    const uid = socket.data.uid;

    // Check ripgrep availability
    await this.checkRipgrepAvailability();

    if (!this.ripgrepAvailable) {
      // Fall back to Node.js implementation
      return await this.findWithStreamNode(params, socket);
    }

    // Build ripgrep arguments
    const args: string[] = [
      '--json',           // Output as JSON
      '--max-count', maxResults.toString(), // Max matches per file (high limit for streaming)
      '--with-filename',  // Include filename in output
      '--line-number',    // Include line numbers
    ];

    // Case sensitivity
    if (matchCase) {
      args.push('--case-sensitive');
    } else {
      args.push('--ignore-case');
    }

    // Regex mode
    if (!useRegEx) {
      args.push('--fixed-strings');
    }

    // Whole words
    if (onlyWholeWords) {
      args.push('--word-regexp');
    }

    // Add glob pattern
    if (glob) {
      args.push('--glob', glob);
    }

    // Add pattern and search directory
    args.push('--', searchTerm, '.');

    try {
      let batch: SearchResult[] = [];
      let totalResults = 0;
      const searchRoot = this.rootPath;

      // Execute ripgrep with streaming - process results as they arrive
      await executeRipgrepStream(searchRoot, args, {
        timeout: 300000, // 5 minute timeout for large searches
        onLine: (line: string) => {
          if (totalResults >= maxResults) return;

          try {
            const json = JSON.parse(line);

            // Only process match messages
            if (json.type === 'match') {
              const data = json.data;
              const lineText = data.lines?.text || '';
              const submatches = data.submatches || [];

              // Skip if no line text
              if (!lineText) {
                return;
              }

              // Process each submatch
              for (const submatch of submatches) {
                if (totalResults >= maxResults) break;

                const matchStart = submatch.start;
                const matchEnd = submatch.end;
                const matchValue = lineText.substring(matchStart, matchEnd);

                // Trim line to show context around match
                const { line: trimmedLine, offset: trimOffset } = this.trimLineToMatch(lineText, matchStart, matchEnd, maxLength);

                // Calculate match positions relative to trimmed line
                const relativeMatchStart = matchStart - trimOffset;
                const relativeMatchEnd = matchEnd - trimOffset;

                // Get file path relative to root
                const relativePath = path.relative(searchRoot, data.path.text);

                batch.push({
                  start: {
                    row: data.line_number - 1,
                    column: matchStart
                  },
                  end: {
                    row: data.line_number - 1,
                    column: matchEnd
                  },
                  range: {
                    start: data.absolute_offset + matchStart,
                    end: data.absolute_offset + matchEnd
                  },
                  line: trimmedLine,
                  value: matchValue,
                  match: {
                    start: relativeMatchStart,
                    end: relativeMatchEnd
                  },
                  path: relativePath
                });

                totalResults++;

                if (batch.length >= 25) {
                  socket.emit('rpc', {
                    jsonrpc: '2.0',
                    method: 'search.results',
                    params: {
                      results: batch,
                      done: false
                    }
                  });
                  batch = [];
                }
              }
            }
          } catch (error) {
            // Skip malformed JSON lines
          }
        }
      });

      // Send remaining results if any
      if (batch.length > 0) {
        socket.emit('rpc', {
          jsonrpc: '2.0',
          method: 'search.results',
          params: {
            results: batch,
            done: false
          }
        });
      }

      // Send completion notification
      socket.emit('rpc', {
        jsonrpc: '2.0',
        method: 'search.results',
        params: {
          results: [],
          done: true,
          total: totalResults
        }
      });

      logSearchRead('findWithStream', params, uid, true, undefined, {
        matches: totalResults,
        method: 'ripgrep-stream',
        glob
      });
    } catch (error: any) {
      logSearchRead('findWithStream', params, uid, false, error, {
        method: 'ripgrep-stream',
        glob
      });

      // Send error notification
      socket.emit('rpc', {
        jsonrpc: '2.0',
        method: 'search.error',
        params: {
          error: error.message
        }
      });

      throw error;
    }
  }

  /**
   * Stream search results using Node.js implementation
   * Used as fallback when ripgrep is not available
   */
  private async findWithStreamNode(params: StreamSearchParams, socket: AuthenticatedSocket): Promise<void> {
    const { glob, rootDir, maxResults, searchTerm, matchCase, useRegEx, onlyWholeWords } = params;
    const uid = socket.data.uid;

    try {
      // Get all files in the directory
      const files = await this.getAllFiles(this.rootPath, glob);

      let batch: SearchResult[] = [];
      let totalResults = 0;

      // Search through each file
      for (const file of files) {
        if (totalResults >= maxResults) break;

        try {
          const relativePath = path.relative(this.rootPath, file);

          // Check file size
          const stats = await fs.promises.stat(file);
          if (stats.size === 0 || stats.size > this.maxFileSize || stats.isDirectory()) {
            continue;
          }

          // Build regex pattern
          const regex = this.buildRegExp(searchTerm, useRegEx, matchCase, onlyWholeWords);

          // Search the file
          let results: SearchResult[] | null = null;
          if (stats.size < this.chunkSize * 2) {
            results = await this.searchSmallFile(file, relativePath, regex, 100, 10000);
          } else {
            results = await this.searchLargeFile(file, relativePath, regex, 100, 10000);
          }

          if (results && results.length > 0) {
            for (const result of results) {
              if (totalResults >= maxResults) break;

              batch.push(result);
              totalResults++;

              // Send batch when we reach 20 results
              if (batch.length >= 20) {
                socket.emit('rpc', {
                  jsonrpc: '2.0',
                  method: 'search.results',
                  params: { results: batch, done: false }
                });
                batch = [];
              }
            }
          }
        } catch (error) {
          // Skip files that can't be read
          continue;
        }
      }

      // Send final batch if any
      if (batch.length > 0) {
        socket.emit('rpc', {
          jsonrpc: '2.0',
          method: 'search.results',
          params: { results: batch, done: false }
        });
      }

      // Send completion notification
      socket.emit('rpc', {
        jsonrpc: '2.0',
        method: 'search.results',
        params: { results: [], done: true, total: totalResults }
      });

      logSearchRead('findWithStream', params, uid, true, null, {
        matches: totalResults,
        method: 'node-stream',
        glob
      });
    } catch (error: any) {
      logSearchRead('findWithStream', params, uid, false, error, {
        method: 'node-stream',
        glob
      });

      socket.emit('rpc', {
        jsonrpc: '2.0',
        method: 'search.error',
        params: {
          error: error.message
        }
      });

      throw error;
    }
  }

  /**
   * Get all files in a directory matching optional glob pattern
   */
  private async getAllFiles(dir: string, globPattern?: string): Promise<string[]> {
    const files: string[] = [];
    const ignoreSet = new Set(['.git', '.spck-editor', '.DS_Store', 'node_modules', 'dist', 'build']);

    const walk = async (currentDir: string): Promise<void> => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (ignoreSet.has(entry.name)) continue;

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          // Basic glob matching (simple pattern support)
          if (!globPattern || this.matchGlob(fullPath, dir, globPattern)) {
            files.push(fullPath);
          }
        }
      }
    };

    await walk(dir);
    return files;
  }

  /**
   * Simple glob pattern matching
   */
  private matchGlob(filePath: string, baseDir: string, pattern: string): boolean {
    const relativePath = path.relative(baseDir, filePath);

    // Convert glob pattern to regex
    let regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(relativePath);
  }

  /**
   * Handle search RPC methods
   */
  async handle(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    switch (method) {
      case 'findWithStream':
        return await this.findWithStream(params, socket);
      default:
        throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: search.${method}`);
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
      // Log full error server-side
      console.error('Failed to read file for search:', {
        path: absolutePath,
        error: error.message,
      });
      // Send sanitized error to client
      throw createRPCError(ErrorCode.INTERNAL_ERROR, 'Failed to read file');
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
      // Log full error server-side
      console.error('Failed to search file:', {
        path: absolutePath,
        error: error.message,
      });
      // Send sanitized error to client
      throw createRPCError(ErrorCode.INTERNAL_ERROR, 'Failed to search file');
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
