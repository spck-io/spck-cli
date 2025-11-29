/**
 * File system watcher using chokidar
 */

import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';

export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher;

  constructor(rootPath: string, ignorePatterns: string[]) {
    super();

    this.watcher = chokidar.watch(rootPath, {
      ignored: ignorePatterns,
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
