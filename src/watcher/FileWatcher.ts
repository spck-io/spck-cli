/**
 * File system watcher using chokidar
 */

import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import * as path from 'path';

export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher;

  /**
   * @param ignoredDirNames Directory names to skip anywhere in the tree
   *   (e.g. 'node_modules'). chokidar 4+ no longer accepts globs, so this
   *   matches whole path segments instead; ignored directories are not
   *   descended into.
   */
  constructor(rootPath: string, ignoredDirNames: string[]) {
    super();

    const ignored = new Set(ignoredDirNames);
    const root = path.resolve(rootPath);
    this.watcher = chokidar.watch(rootPath, {
      ignored: (filePath: string) => {
        const rel = path.relative(root, path.resolve(filePath));
        return rel !== '' && rel.split(path.sep).some((segment) => ignored.has(segment));
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on('change', (path, stats) => {
      this.emit('change', path, stats?.mtimeMs);
    });

    this.watcher.on('unlink', (path) => {
      this.emit('removed', path);
    });

    this.watcher.on('add', (path, stats) => {
      this.emit('added', path, stats?.mtimeMs);
    });

    this.watcher.on('unlinkDir', (path) => {
      this.emit('removed', path);
    });

    this.watcher.on('addDir', (path) => {
      this.emit('added', path);
    });

    this.watcher.on('error', (error) => {
      console.error('File watcher error:', error);
      this.emit('error', error);
    });
  }

  close(): void {
    this.watcher.close();
  }
}
