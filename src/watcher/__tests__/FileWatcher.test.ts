import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher } from '../FileWatcher.js';

describe('FileWatcher', () => {
  let root: string;
  let watcher: FileWatcher;
  let events: string[];

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spck-watch-')));
    watcher = new FileWatcher(root, ['node_modules']);
    events = [];
    watcher.on('added', (p: string, _mtime: number | undefined, type: string) => events.push(`added ${type} ${path.relative(root, p)}`));
    watcher.on('removed', (p: string, type: string) => events.push(`removed ${type} ${path.relative(root, p)}`));
    watcher.on('change', (p: string) => events.push(`change ${path.relative(root, p)}`));
    // chokidar is ready once its first scan is done
    await new Promise((resolve) => (watcher as any).watcher.once('ready', resolve));
  });

  afterEach(() => {
    watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('says whether an added or removed path is a file or a folder', async () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'one');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), '');
    await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining(['added folder src', 'added file src/a.ts'])), { timeout: 5000 });

    fs.appendFileSync(path.join(root, 'src', 'a.ts'), ' two');
    await vi.waitFor(() => expect(events).toContain('change src/a.ts'), { timeout: 5000 });

    fs.rmSync(path.join(root, 'src'), { recursive: true });
    await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining(['removed file src/a.ts', 'removed folder src'])), { timeout: 5000 });
    expect(events.filter((event) => event.includes('node_modules'))).toEqual([]);
  });
});
