/**
 * Tests for GitService
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { GitService } from '../GitService.js';
import { ErrorCode } from '../../types.js';

// Helper to execute git commands for test setup
async function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const git = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    git.stdout.on('data', (data) => (stdout += data.toString()));
    git.stderr.on('data', (data) => (stderr += data.toString()));

    git.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Git failed: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

describe('GitService', () => {
  let service: GitService;
  let testRoot: string;
  let repoPath: string;
  let mockSocket: any;

  beforeEach(async () => {
    // Create temporary test directory
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'git-test-'));
    repoPath = path.join(testRoot, 'repo');
    await fs.mkdir(repoPath);

    service = new GitService(testRoot);

    mockSocket = {
      id: 'test-socket',
      data: { uid: 'test-user', deviceId: 'test-device' },
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      broadcast: {
        emit: jest.fn(),
      },
    };
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  describe('Path Validation', () => {
    it('should accept valid paths', async () => {
      await execGit(['init'], repoPath);

      const result = await service.handle(
        'currentBranch',
        { dir: '/repo' },
        mockSocket
      );

      // Should not throw error
      expect(result).toBeDefined();
    });

    it('should prevent directory traversal', async () => {
      await expect(
        service.handle('currentBranch', { dir: '../../../etc' }, mockSocket)
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PATH,
        message: expect.stringContaining('directory traversal'),
      });
    });

    it('should prevent access outside root', async () => {
      // Path validation clamps to root, so the directory just won't exist
      // This will result in a git error rather than a path validation error
      const result = await service.handle(
        'currentBranch',
        { dir: '/../../../../etc' },
        mockSocket
      );

      // currentBranch returns null for invalid repos (no error thrown)
      expect(result.branch).toBeNull();
    });
  });

  describe('Git Operations - init', () => {
    it('should initialize a new repository', async () => {
      const result = await service.handle('init', { dir: '/repo' }, mockSocket);

      expect(result.success).toBe(true);

      // Verify .git directory was created
      const gitDir = path.join(repoPath, '.git');
      const stats = await fs.stat(gitDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should initialize with custom default branch', async () => {
      await service.handle(
        'init',
        { dir: '/repo', defaultBranch: 'main' },
        mockSocket
      );

      const branch = await execGit(['symbolic-ref', '--short', 'HEAD'], repoPath);
      expect(branch).toBe('main');
    });
  });

  describe('Git Operations - currentBranch', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial commit'], repoPath);
    });

    it('should return current branch short name', async () => {
      const result = await service.handle(
        'currentBranch',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.branch).toBeTruthy();
      expect(result.branch).not.toContain('refs/heads/');
    });

    it('should return full branch name when fullname is true', async () => {
      const result = await service.handle(
        'currentBranch',
        { dir: '/repo', fullname: true },
        mockSocket
      );

      expect(result.branch).toContain('refs/heads/');
    });

    it('should return null for detached HEAD', async () => {
      // Get commit hash and checkout to detach HEAD
      const oid = await execGit(['rev-parse', 'HEAD'], repoPath);
      await execGit(['checkout', oid], repoPath);

      const result = await service.handle(
        'currentBranch',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.branch).toBeNull();
    });
  });

  describe('Git Operations - add', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
    });

    it('should stage single file', async () => {
      await fs.writeFile(path.join(repoPath, 'new.txt'), 'content');

      const result = await service.handle(
        'add',
        { dir: '/repo', filepaths: ['new.txt'] },
        mockSocket
      );

      expect(result.success).toBe(true);

      const status = await execGit(['status', '--porcelain'], repoPath);
      expect(status).toContain('A  new.txt');
    });

    it('should stage multiple files', async () => {
      await fs.writeFile(path.join(repoPath, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(repoPath, 'file2.txt'), 'content2');

      await service.handle(
        'add',
        { dir: '/repo', filepaths: ['file1.txt', 'file2.txt'] },
        mockSocket
      );

      const status = await execGit(['status', '--porcelain'], repoPath);
      expect(status).toContain('file1.txt');
      expect(status).toContain('file2.txt');
    });
  });

  describe('Git Operations - commit', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);
    });

    it('should create a commit', async () => {
      const result = await service.handle(
        'commit',
        {
          dir: '/repo',
          message: 'Test commit',
          author: {
            name: 'Test Author',
            email: 'author@example.com',
          },
        },
        mockSocket
      );

      expect(result.oid).toBeTruthy();
      expect(result.oid).toMatch(/^[0-9a-f]{40}$/);

      const commitMsg = await execGit(['log', '-1', '--format=%s'], repoPath);
      expect(commitMsg).toBe('Test commit');
    });

    it('should broadcast change notification', async () => {
      await service.handle(
        'commit',
        {
          dir: '/repo',
          message: 'Test commit',
          author: {
            name: 'Test Author',
            email: 'author@example.com',
          },
        },
        mockSocket
      );

      expect(mockSocket.broadcast.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'git.changed',
          params: { dir: expect.any(String) },
        })
      );
    });
  });

  describe('Git Operations - readCommit', () => {
    let commitOid: string;

    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Test commit message'], repoPath);
      commitOid = await execGit(['rev-parse', 'HEAD'], repoPath);
    });

    it('should read commit object', async () => {
      const result = await service.handle(
        'readCommit',
        { dir: '/repo', oid: commitOid },
        mockSocket
      );

      expect(result.oid).toBe(commitOid);
      expect(result.commit).toMatchObject({
        message: expect.stringContaining('Test commit message'),
        tree: expect.stringMatching(/^[0-9a-f]{40}$/),
        parent: expect.any(Array),
        author: expect.objectContaining({
          name: expect.any(String),
          email: expect.any(String),
          timestamp: expect.any(Number),
        }),
        committer: expect.objectContaining({
          name: expect.any(String),
          email: expect.any(String),
          timestamp: expect.any(Number),
        }),
      });
    });

    it('should parse author and committer correctly', async () => {
      const result = await service.handle(
        'readCommit',
        { dir: '/repo', oid: commitOid },
        mockSocket
      );

      expect(result.commit.author.name).toBe('Test User');
      expect(result.commit.author.email).toBe('test@example.com');
      expect(result.commit.committer.name).toBe('Test User');
      expect(result.commit.committer.email).toBe('test@example.com');
    });
  });

  describe('Git Operations - log', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);

      // Create multiple commits
      for (let i = 1; i <= 3; i++) {
        await fs.writeFile(path.join(repoPath, `file${i}.txt`), `content${i}`);
        await execGit(['add', '.'], repoPath);
        await execGit(['commit', '-m', `Commit ${i}`], repoPath);
      }
    });

    it('should return commit history', async () => {
      const result = await service.handle('log', { dir: '/repo' }, mockSocket);

      expect(result.commits).toHaveLength(3);
      expect(result.commits[0].commit.message).toContain('Commit 3');
      expect(result.commits[2].commit.message).toContain('Commit 1');
    });

    it('should limit history with depth parameter', async () => {
      const result = await service.handle(
        'log',
        { dir: '/repo', depth: 2 },
        mockSocket
      );

      expect(result.commits).toHaveLength(2);
    });

    it('should return commits in reverse chronological order', async () => {
      const result = await service.handle('log', { dir: '/repo' }, mockSocket);

      const messages = result.commits.map((c: any) => c.commit.message.trim());
      expect(messages).toEqual(['Commit 3', 'Commit 2', 'Commit 1']);
    });
  });

  describe('Git Operations - status', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'committed.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial'], repoPath);
    });

    it('should return empty array for clean working directory', async () => {
      const result = await service.handle(
        'status',
        { dir: '/repo' },
        mockSocket
      );

      expect(result).toEqual([]);
    });

    it('should show modified files in status', async () => {
      await fs.writeFile(path.join(repoPath, 'committed.txt'), 'modified');

      const result = await service.handle(
        'status',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].path).toBe('committed.txt');
      expect(result[0].status).toBeDefined();
    });

    it('should show new untracked files', async () => {
      await fs.writeFile(path.join(repoPath, 'new.txt'), 'content');

      const result = await service.handle(
        'status',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.some((item: any) => item.path === 'new.txt')).toBe(true);
    });
  });

  describe('Git Operations - listBranches', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial'], repoPath);
    });

    it('should list local branches', async () => {
      await execGit(['checkout', '-b', 'feature'], repoPath);

      const result = await service.handle(
        'listBranches',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.branches).toContain('feature');
    });

    it('should filter out empty lines', async () => {
      const result = await service.handle(
        'listBranches',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.branches.every((b: string) => b.length > 0)).toBe(true);
    });
  });

  describe('Git Operations - checkout', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial'], repoPath);
      await execGit(['checkout', '-b', 'develop'], repoPath);
    });

    it('should checkout branch', async () => {
      const defaultBranch = await execGit(['symbolic-ref', '--short', 'HEAD'], repoPath);

      await service.handle(
        'checkout',
        { dir: '/repo', ref: defaultBranch },
        mockSocket
      );

      const currentBranch = await execGit(['symbolic-ref', '--short', 'HEAD'], repoPath);
      expect(currentBranch).toBe(defaultBranch);
    });

    it('should checkout with force option', async () => {
      // Make uncommitted changes
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'modified');

      const result = await service.handle(
        'checkout',
        { dir: '/repo', ref: 'HEAD', force: true },
        mockSocket
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Git Operations - requestAuth', () => {
    it('should request authentication from client', async () => {
      const mockResponse = {
        username: 'testuser',
        password: 'testpass',
      };

      let requestId: number | null = null;

      // Capture the request ID when emit is called
      mockSocket.emit.mockImplementation((event: string, data: any) => {
        if (event === 'rpc' && data.method === 'git.requestAuth') {
          requestId = data.id;
        }
      });

      // Set up response handler
      const onHandlers: Function[] = [];
      mockSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'rpc') {
          onHandlers.push(handler);
        }
      });

      // Start the auth request
      const authPromise = service.handle(
        'requestAuth',
        { dir: '/repo', url: 'https://github.com/user/repo.git' },
        mockSocket
      );

      // Wait a tick for the emit to happen
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate client response
      expect(requestId).not.toBeNull();
      onHandlers.forEach((handler) => {
        handler({
          id: requestId,
          result: mockResponse,
        });
      });

      const result = await authPromise;
      expect(result).toEqual(mockResponse);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown git method', async () => {
      await execGit(['init'], repoPath);

      await expect(
        service.handle('unknownMethod', { dir: '/repo' }, mockSocket)
      ).rejects.toMatchObject({
        code: ErrorCode.METHOD_NOT_FOUND,
        message: expect.stringContaining('Method not found'),
      });
    });

    it('should wrap git command errors', async () => {
      await execGit(['init'], repoPath);

      // Try to read non-existent commit
      await expect(
        service.handle(
          'readCommit',
          { dir: '/repo', oid: '0000000000000000000000000000000000000000' },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.GIT_OPERATION_FAILED,
        message: expect.stringContaining('Git operation failed'),
      });
    });

    it('should handle invalid git directories', async () => {
      // currentBranch catches errors and returns null for detached/invalid repos
      const result = await service.handle(
        'currentBranch',
        { dir: '/nonexistent' },
        mockSocket
      );

      expect(result.branch).toBeNull();
    });
  });

  describe('Git Operations - remove', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial'], repoPath);
    });

    it('should remove files from index', async () => {
      await fs.writeFile(path.join(repoPath, 'new.txt'), 'content');
      await execGit(['add', 'new.txt'], repoPath);

      const result = await service.handle(
        'remove',
        { dir: '/repo', filepaths: ['new.txt'] },
        mockSocket
      );

      expect(result.success).toBe(true);

      const status = await execGit(['status', '--porcelain'], repoPath);
      expect(status).not.toContain('A  new.txt');
      expect(status).toContain('?? new.txt');
    });

    it('should broadcast change notification', async () => {
      await fs.writeFile(path.join(repoPath, 'new.txt'), 'content');
      await execGit(['add', 'new.txt'], repoPath);

      await service.handle(
        'remove',
        { dir: '/repo', filepaths: ['new.txt'] },
        mockSocket
      );

      expect(mockSocket.broadcast.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'git.changed',
          params: { dir: expect.any(String) },
        })
      );
    });
  });

  describe('Git Operations - resetIndex', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'original');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial'], repoPath);
    });

    it('should reset modified file to HEAD', async () => {
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'modified');
      await execGit(['add', 'file.txt'], repoPath);

      const result = await service.handle(
        'resetIndex',
        { dir: '/repo', filepath: 'file.txt' },
        mockSocket
      );

      expect(result.success).toBe(true);

      const status = await execGit(['status', '--porcelain'], repoPath);
      // After reset, file should be unstaged (not "M  " which is staged)
      expect(status).not.toContain('M  file.txt');
      // File should show as modified in working directory
      expect(status).toContain('file.txt');
    });

    it('should reset new file (remove from index)', async () => {
      await fs.writeFile(path.join(repoPath, 'new.txt'), 'content');
      await execGit(['add', 'new.txt'], repoPath);

      await service.handle(
        'resetIndex',
        { dir: '/repo', filepath: 'new.txt' },
        mockSocket
      );

      const status = await execGit(['status', '--porcelain'], repoPath);
      expect(status).not.toContain('A  new.txt');
      expect(status).toContain('?? new.txt');
    });

    it('should use custom ref when provided', async () => {
      // Create a second commit
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'second version');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Second'], repoPath);

      // Modify and stage
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'modified');
      await execGit(['add', 'file.txt'], repoPath);

      // Reset to HEAD~1 (first commit)
      await service.handle(
        'resetIndex',
        { dir: '/repo', filepath: 'file.txt', ref: 'HEAD~1' },
        mockSocket
      );

      const result = await service.handle(
        'resetIndex',
        { dir: '/repo', filepath: 'file.txt' },
        mockSocket
      );

      expect(result.success).toBe(true);
    });

    it('should broadcast change notification', async () => {
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'modified');
      await execGit(['add', 'file.txt'], repoPath);

      await service.handle(
        'resetIndex',
        { dir: '/repo', filepath: 'file.txt' },
        mockSocket
      );

      expect(mockSocket.broadcast.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'git.changed',
          params: { dir: expect.any(String) },
        })
      );
    });
  });

  describe('Git Operations - getConfig and setConfig', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
    });

    it('should get existing config value', async () => {
      const result = await service.handle(
        'getConfig',
        { dir: '/repo', path: 'user.name' },
        mockSocket
      );

      expect(result.value).toBe('Test User');
    });

    it('should return undefined for non-existent config key', async () => {
      const result = await service.handle(
        'getConfig',
        { dir: '/repo', path: 'nonexistent.key' },
        mockSocket
      );

      expect(result.value).toBeUndefined();
    });

    it('should set config value', async () => {
      await service.handle(
        'setConfig',
        { dir: '/repo', path: 'user.name', value: 'New Name' },
        mockSocket
      );

      const result = await execGit(['config', '--get', 'user.name'], repoPath);
      expect(result).toBe('New Name');
    });

    it('should set boolean config value', async () => {
      await service.handle(
        'setConfig',
        { dir: '/repo', path: 'core.bare', value: true },
        mockSocket
      );

      const result = await execGit(['config', '--get', 'core.bare'], repoPath);
      expect(result).toBe('true');
    });

    it('should set number config value', async () => {
      await service.handle(
        'setConfig',
        { dir: '/repo', path: 'core.compression', value: 5 },
        mockSocket
      );

      const result = await execGit(['config', '--get', 'core.compression'], repoPath);
      expect(result).toBe('5');
    });

    it('should unset config value when value is undefined', async () => {
      await execGit(['config', 'test.key', 'testvalue'], repoPath);

      await service.handle(
        'setConfig',
        { dir: '/repo', path: 'test.key', value: undefined },
        mockSocket
      );

      const result = await service.handle(
        'getConfig',
        { dir: '/repo', path: 'test.key' },
        mockSocket
      );

      expect(result.value).toBeUndefined();
    });

    it('should append config value when append is true', async () => {
      await execGit(['config', 'test.multi', 'value1'], repoPath);

      await service.handle(
        'setConfig',
        { dir: '/repo', path: 'test.multi', value: 'value2', append: true },
        mockSocket
      );

      // Get all values
      const result = await execGit(['config', '--get-all', 'test.multi'], repoPath);
      expect(result).toContain('value1');
      expect(result).toContain('value2');
    });

    it('should handle unsetting non-existent key gracefully', async () => {
      const result = await service.handle(
        'setConfig',
        { dir: '/repo', path: 'nonexistent.key', value: undefined },
        mockSocket
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Commit Parsing', () => {
    it('should handle commits with multiple parents (merge commits)', async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);

      // Create initial commit on default branch
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'base');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial'], repoPath);
      const defaultBranch = await execGit(['symbolic-ref', '--short', 'HEAD'], repoPath);

      // Create a commit on the default branch to prevent fast-forward
      await fs.writeFile(path.join(repoPath, 'base.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Base commit'], repoPath);

      // Create branch from first commit
      const firstCommit = await execGit(['rev-list', '--max-parents=0', 'HEAD'], repoPath);
      await execGit(['checkout', '-b', 'feature', firstCommit], repoPath);
      await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Feature'], repoPath);

      // Merge back to create a true merge commit
      await execGit(['checkout', defaultBranch], repoPath);
      await execGit(['merge', 'feature', '--no-ff', '-m', 'Merge feature'], repoPath);

      const mergeOid = await execGit(['rev-parse', 'HEAD'], repoPath);
      const result = await service.handle(
        'readCommit',
        { dir: '/repo', oid: mergeOid },
        mockSocket
      );

      // Should have 2 parents (merge commit)
      expect(result.commit.parent.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle multiline commit messages', async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);

      const multilineMessage = 'First line\n\nSecond paragraph\nThird line';
      await execGit(['commit', '-m', multilineMessage], repoPath);

      const oid = await execGit(['rev-parse', 'HEAD'], repoPath);
      const result = await service.handle(
        'readCommit',
        { dir: '/repo', oid },
        mockSocket
      );

      expect(result.commit.message.trim()).toBe(multilineMessage);
    });
  });

  describe('Git Operations - listRemotes', () => {
    it('should return empty array when no remotes', async () => {
      await execGit(['init'], repoPath);

      const result = await service.handle(
        'listRemotes',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.remotes).toEqual([]);
    });

    it('should list configured remotes', async () => {
      await execGit(['init'], repoPath);
      await execGit(['remote', 'add', 'origin', 'https://github.com/user/repo.git'], repoPath);
      await execGit(['remote', 'add', 'upstream', 'https://github.com/upstream/repo.git'], repoPath);

      const result = await service.handle(
        'listRemotes',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.remotes).toHaveLength(2);
      expect(result.remotes.some((r: any) => r.remote === 'origin')).toBe(true);
      expect(result.remotes.some((r: any) => r.remote === 'upstream')).toBe(true);
      expect(result.remotes[0]).toHaveProperty('url');
    });
  });

  describe('Git Operations - addRemote', () => {
    it('should add a new remote', async () => {
      await execGit(['init'], repoPath);

      const result = await service.handle(
        'addRemote',
        { dir: '/repo', remote: 'origin', url: 'https://github.com/user/repo.git' },
        mockSocket
      );

      expect(result.success).toBe(true);

      // Verify remote was added
      const remotes = await execGit(['remote', '-v'], repoPath);
      expect(remotes).toContain('origin');
      expect(remotes).toContain('https://github.com/user/repo.git');
    });
  });

  describe('Git Operations - deleteRemote', () => {
    it('should delete an existing remote', async () => {
      await execGit(['init'], repoPath);
      await execGit(['remote', 'add', 'origin', 'https://github.com/user/repo.git'], repoPath);

      const result = await service.handle(
        'deleteRemote',
        { dir: '/repo', remote: 'origin' },
        mockSocket
      );

      expect(result.success).toBe(true);

      // Verify remote was deleted
      const remotes = await execGit(['remote'], repoPath);
      expect(remotes).not.toContain('origin');
    });
  });

  describe('Git Operations - clearIndex', () => {
    it('should clear the git index', async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);

      // Add files to index
      await fs.writeFile(path.join(repoPath, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(repoPath, 'file2.txt'), 'content2');
      await execGit(['add', '.'], repoPath);

      const result = await service.handle(
        'clearIndex',
        { dir: '/repo' },
        mockSocket
      );

      expect(result.success).toBe(true);

      // Verify index is empty
      const status = await execGit(['status', '--porcelain'], repoPath);
      expect(status).toContain('??'); // Files should be untracked now
    });
  });

  describe('Git Operations - isIgnored', () => {
    it('should return false for non-ignored files', async () => {
      await execGit(['init'], repoPath);
      await fs.writeFile(path.join(repoPath, 'regular.txt'), 'content');

      const result = await service.handle(
        'isIgnored',
        { dir: '/repo', filepath: 'regular.txt' },
        mockSocket
      );

      expect(result).toBe(false);
    });

    it('should return true for ignored files', async () => {
      await execGit(['init'], repoPath);
      await fs.writeFile(path.join(repoPath, '.gitignore'), '*.log\nnode_modules/');
      await fs.writeFile(path.join(repoPath, 'test.log'), 'logs');

      const result = await service.handle(
        'isIgnored',
        { dir: '/repo', filepath: 'test.log' },
        mockSocket
      );

      expect(result).toBe(true);
    });
  });

  describe('Git Operations - isInitialized', () => {
    it('should return false for non-git directory', async () => {
      const result = await service.handle(
        'isInitialized',
        { dir: '/repo' },
        mockSocket
      );

      expect(result).toBe(false);
    });

    it('should return true for initialized git repository', async () => {
      await execGit(['init'], repoPath);

      const result = await service.handle(
        'isInitialized',
        { dir: '/repo' },
        mockSocket
      );

      expect(result).toBe(true);
    });
  });

  describe('Git Operations - resolveRef', () => {
    it('should resolve HEAD to commit oid', async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial'], repoPath);

      const expected = await execGit(['rev-parse', 'HEAD'], repoPath);

      const result = await service.handle(
        'resolveRef',
        { dir: '/repo', ref: 'HEAD' },
        mockSocket
      );

      expect(result.oid).toBe(expected);
    });

    it('should resolve branch name to commit oid', async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execGit(['add', '.'], repoPath);
      await execGit(['commit', '-m', 'Initial'], repoPath);

      const branch = await execGit(['symbolic-ref', '--short', 'HEAD'], repoPath);
      const expected = await execGit(['rev-parse', 'HEAD'], repoPath);

      const result = await service.handle(
        'resolveRef',
        { dir: '/repo', ref: branch },
        mockSocket
      );

      expect(result.oid).toBe(expected);
    });
  });

  describe('Command Injection Prevention', () => {
    beforeEach(async () => {
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);
    });

    describe('add command', () => {
      it('should reject filenames starting with dash', async () => {
        await fs.writeFile(path.join(repoPath, '-evil.txt'), 'content');

        await expect(
          service.handle(
            'add',
            { dir: '/repo', filepaths: ['-evil.txt'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('cannot start with dash'),
        });
      });

      it('should reject filenames with control characters', async () => {
        await expect(
          service.handle(
            'add',
            { dir: '/repo', filepaths: ['file\x00.txt'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('control characters'),
        });
      });

      it('should reject filenames with newlines', async () => {
        await expect(
          service.handle(
            'add',
            { dir: '/repo', filepaths: ['file\n.txt'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('newline'),
        });
      });

      it('should accept valid filenames with special characters', async () => {
        await fs.writeFile(path.join(repoPath, 'file@#$%.txt'), 'content');

        const result = await service.handle(
          'add',
          { dir: '/repo', filepaths: ['file@#$%.txt'] },
          mockSocket
        );

        expect(result.success).toBe(true);
      });

      it('should reject when any filename in array is malicious', async () => {
        await fs.writeFile(path.join(repoPath, 'good.txt'), 'content');
        await fs.writeFile(path.join(repoPath, '-evil.txt'), 'content');

        await expect(
          service.handle(
            'add',
            { dir: '/repo', filepaths: ['good.txt', '-evil.txt'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('cannot start with dash'),
        });
      });
    });

    describe('remove command', () => {
      beforeEach(async () => {
        await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
        await execGit(['add', '.'], repoPath);
        await execGit(['commit', '-m', 'Initial'], repoPath);
      });

      it('should reject filenames starting with dash', async () => {
        await expect(
          service.handle(
            'remove',
            { dir: '/repo', filepaths: ['-evil.txt'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('cannot start with dash'),
        });
      });

      it('should reject filenames with control characters', async () => {
        await expect(
          service.handle(
            'remove',
            { dir: '/repo', filepaths: ['file\x1F.txt'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('control characters'),
        });
      });

      it('should reject filenames with carriage returns', async () => {
        await expect(
          service.handle(
            'remove',
            { dir: '/repo', filepaths: ['file\r.txt'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('newline'),
        });
      });
    });

    describe('resetIndex command', () => {
      beforeEach(async () => {
        await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
        await execGit(['add', '.'], repoPath);
        await execGit(['commit', '-m', 'Initial'], repoPath);
      });

      it('should reject single filepath starting with dash', async () => {
        await expect(
          service.handle(
            'resetIndex',
            { dir: '/repo', filepath: '-evil.txt' },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('cannot start with dash'),
        });
      });

      it('should reject filepaths array with dash-prefixed filename', async () => {
        await expect(
          service.handle(
            'resetIndex',
            { dir: '/repo', filepaths: ['-evil.txt'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('cannot start with dash'),
        });
      });

      it('should reject filepath with DEL character', async () => {
        await expect(
          service.handle(
            'resetIndex',
            { dir: '/repo', filepath: 'file\x7F.txt' },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
          message: expect.stringContaining('control characters'),
        });
      });

      it('should accept valid filepath in single mode', async () => {
        await fs.writeFile(path.join(repoPath, 'valid.txt'), 'content');
        await execGit(['add', 'valid.txt'], repoPath);

        const result = await service.handle(
          'resetIndex',
          { dir: '/repo', filepath: 'valid.txt' },
          mockSocket
        );

        expect(result.success).toBe(true);
      });

      it('should accept valid filepaths in array mode', async () => {
        await fs.writeFile(path.join(repoPath, 'valid1.txt'), 'content1');
        await fs.writeFile(path.join(repoPath, 'valid2.txt'), 'content2');
        await execGit(['add', '.'], repoPath);

        const result = await service.handle(
          'resetIndex',
          { dir: '/repo', filepaths: ['valid1.txt', 'valid2.txt'] },
          mockSocket
        );

        expect(result.success).toBe(true);
      });
    });

    describe('flag injection via -- separator', () => {
      it('should safely handle files that look like git flags in add', async () => {
        // This test verifies that the -- separator prevents flag injection
        // Even though the filename starts with -, it's sanitized before reaching git
        await expect(
          service.handle(
            'add',
            { dir: '/repo', filepaths: ['--version'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
        });
      });

      it('should safely handle files that look like git flags in remove', async () => {
        await expect(
          service.handle(
            'remove',
            { dir: '/repo', filepaths: ['--help'] },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
        });
      });

      it('should safely handle files that look like git flags in resetIndex', async () => {
        await expect(
          service.handle(
            'resetIndex',
            { dir: '/repo', filepath: '--cached' },
            mockSocket
          )
        ).rejects.toMatchObject({
          code: ErrorCode.INVALID_PATH,
        });
      });
    });
  });

  describe('bulkIsIgnored', () => {
    beforeEach(async () => {
      // Initialize git repository
      await execGit(['init'], repoPath);
      await execGit(['config', 'user.email', 'test@example.com'], repoPath);
      await execGit(['config', 'user.name', 'Test User'], repoPath);

      // Create .gitignore with test patterns
      await fs.writeFile(
        path.join(repoPath, '.gitignore'),
        '*.log\nnode_modules/\n.env\nbuild/\n'
      );

      // Create test files
      await fs.writeFile(path.join(repoPath, 'file1.js'), 'test');
      await fs.writeFile(path.join(repoPath, 'file2.log'), 'test');
      await fs.writeFile(path.join(repoPath, '.env'), 'test');
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'src', 'index.js'), 'test');
      await fs.mkdir(path.join(repoPath, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'node_modules', 'test.js'), 'test');
    });

    it('should check multiple files and return 1/0 for ignored status', async () => {
      const result = await service.handle(
        'bulkIsIgnored',
        {
          dir: '/repo',
          filepaths: [
            'file1.js',      // not ignored
            'file2.log',     // ignored (*.log)
            '.env',          // ignored
            'src/index.js',  // not ignored
            'node_modules/test.js' // ignored
          ]
        },
        mockSocket
      );

      expect(result).toEqual([0, 1, 1, 0, 1]);
    });

    it('should return empty array for empty input', async () => {
      const result = await service.handle(
        'bulkIsIgnored',
        {
          dir: '/repo',
          filepaths: []
        },
        mockSocket
      );

      expect(result).toEqual([]);
    });

    it('should handle all ignored files', async () => {
      const result = await service.handle(
        'bulkIsIgnored',
        {
          dir: '/repo',
          filepaths: [
            'file2.log',
            'debug.log',
            '.env',
            'node_modules/package.json'
          ]
        },
        mockSocket
      );

      expect(result).toEqual([1, 1, 1, 1]);
    });

    it('should handle all non-ignored files', async () => {
      const result = await service.handle(
        'bulkIsIgnored',
        {
          dir: '/repo',
          filepaths: [
            'file1.js',
            'src/index.js',
            'package.json',
            'README.md'
          ]
        },
        mockSocket
      );

      expect(result).toEqual([0, 0, 0, 0]);
    });

    it('should work with single file', async () => {
      const result = await service.handle(
        'bulkIsIgnored',
        {
          dir: '/repo',
          filepaths: ['file2.log']
        },
        mockSocket
      );

      expect(result).toEqual([1]);
    });

    it('should handle nested gitignore patterns', async () => {
      await fs.mkdir(path.join(repoPath, 'build'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'build', 'output.js'), 'test');

      const result = await service.handle(
        'bulkIsIgnored',
        {
          dir: '/repo',
          filepaths: [
            'build/output.js',  // ignored (build/ pattern)
            'src/build.js'      // not ignored
          ]
        },
        mockSocket
      );

      expect(result).toEqual([1, 0]);
    });

    it('should throw error for invalid params', async () => {
      await expect(
        service.handle(
          'bulkIsIgnored',
          {
            dir: '/repo',
            filepaths: 'not-an-array'
          },
          mockSocket
        )
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMS,
        message: 'filepaths must be an array'
      });
    });
  });
});
