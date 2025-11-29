/**
 * Git service - executes command-line git operations
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { AuthenticatedSocket, ErrorCode, createRPCError } from '../types';

interface ExecGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

interface ExecGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitService {
  constructor(private rootPath: string) {}

  /**
   * Handle git RPC methods
   */
  async handle(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    // Validate and resolve git directory
    const dir = this.validateGitDir(params.dir);

    try {
      switch (method) {
        case 'readCommit':
          return await this.readCommit(dir, params);
        case 'readObject':
          return await this.readObject(dir, params);
        case 'getHeadTree':
          return await this.getHeadTree(dir, params);
        case 'getOidAtPath':
          return await this.getOidAtPath(dir, params);
        case 'listFiles':
          return await this.listFiles(dir, params);
        case 'resolveRef':
          return await this.resolveRef(dir, params);
        case 'currentBranch':
          return await this.currentBranch(dir, params);
        case 'log':
          return await this.log(dir, params);
        case 'status':
          return await this.status(dir, params);
        case 'statusCounts':
          return await this.statusCounts(dir, params);
        case 'add':
          return await this.add(dir, params, socket);
        case 'remove':
          return await this.remove(dir, params, socket);
        case 'resetIndex':
          return await this.resetIndex(dir, params, socket);
        case 'commit':
          return await this.commit(dir, params, socket);
        case 'getConfig':
          return await this.getConfig(dir, params);
        case 'setConfig':
          return await this.setConfig(dir, params);
        case 'listBranches':
          return await this.listBranches(dir, params);
        case 'checkout':
          return await this.checkout(dir, params);
        case 'init':
          return await this.init(dir, params);
        case 'listRemotes':
          return await this.listRemotes(dir, params);
        case 'addRemote':
          return await this.addRemote(dir, params);
        case 'deleteRemote':
          return await this.deleteRemote(dir, params);
        case 'clearIndex':
          return await this.clearIndex(dir, params);
        case 'isIgnored':
          return await this.isIgnored(dir, params);
        case 'requestAuth':
          // This is called by server to request credentials from client
          return await this.requestAuth(socket, params);
        default:
          throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: git.${method}`);
      }
    } catch (error: any) {
      if (error.code && error.message) {
        throw error; // Re-throw RPC errors
      }
      throw createRPCError(
        ErrorCode.GIT_OPERATION_FAILED,
        `Git operation failed: ${error.message}`,
        { method, error: error.toString() }
      );
    }
  }

  /**
   * Validate git directory
   */
  private validateGitDir(dir: string): string {
    const normalized = path.normalize(dir);
    if (normalized.includes('..')) {
      throw createRPCError(ErrorCode.INVALID_PATH, 'Invalid path: directory traversal not allowed');
    }

    const absolute = path.resolve(this.rootPath, normalized.startsWith('/') ? normalized.slice(1) : normalized);
    if (!absolute.startsWith(path.resolve(this.rootPath))) {
      throw createRPCError(ErrorCode.INVALID_PATH, 'Access denied: path outside root directory');
    }

    return absolute;
  }

  /**
   * Execute git command
   */
  private async execGit(args: string[], options: ExecGitOptions = {}): Promise<ExecGitResult> {
    return new Promise((resolve, reject) => {
      const git = spawn('git', args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: options.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      if (git.stdout) {
        git.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }

      if (git.stderr) {
        git.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      git.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });

      git.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Git command failed with code ${code}: ${stderr || stdout}`));
        } else {
          resolve({ stdout, stderr, code: code || 0 });
        }
      });

      if (options.input !== undefined && git.stdin) {
        git.stdin.write(options.input);
        git.stdin.end();
      }
    });
  }

  /**
   * Read commit object
   */
  private async readCommit(dir: string, params: any): Promise<any> {
    const { stdout } = await this.execGit(['cat-file', 'commit', params.oid], { cwd: dir });
    const commit = this.parseCommit(stdout);
    return {
      oid: params.oid,
      commit,
    };
  }

  /**
   * Parse commit object
   */
  private parseCommit(commitText: string): any {
    const lines = commitText.split('\n');
    const commit: any = {
      message: '',
      tree: '',
      parent: [],
      author: null,
      committer: null,
    };

    let i = 0;
    while (i < lines.length && lines[i] !== '') {
      const line = lines[i];
      if (line.startsWith('tree ')) {
        commit.tree = line.substring(5);
      } else if (line.startsWith('parent ')) {
        commit.parent.push(line.substring(7));
      } else if (line.startsWith('author ')) {
        commit.author = this.parseIdentity(line.substring(7));
      } else if (line.startsWith('committer ')) {
        commit.committer = this.parseIdentity(line.substring(10));
      }
      i++;
    }

    i++;
    commit.message = lines.slice(i).join('\n');

    return commit;
  }

  /**
   * Parse git identity (author/committer)
   */
  private parseIdentity(identityString: string): any {
    const match = identityString.match(/^(.+) <(.+)> (\d+) ([+-]\d{4})$/);
    if (!match) {
      throw new Error(`Invalid identity format: ${identityString}`);
    }

    return {
      name: match[1],
      email: match[2],
      timestamp: parseInt(match[3], 10),
      timezoneOffset: (parseInt(match[4], 10) / 100) * 60,
    };
  }

  /**
   * Read git object
   */
  private async readObject(dir: string, params: any): Promise<any> {
    const { oid, encoding } = params;
    const { stdout } = await this.execGit(['cat-file', '-p', oid], { cwd: dir });

    return {
      oid,
      object: encoding === 'utf8' ? stdout : Buffer.from(stdout, 'utf8'),
      format: 'content'
    };
  }

  /**
   * Get HEAD tree oid
   */
  private async getHeadTree(dir: string, params: any): Promise<any> {
    try {
      const { stdout } = await this.execGit(['rev-parse', 'HEAD^{tree}'], { cwd: dir });
      return { oid: stdout.trim() };
    } catch (error) {
      // No commits yet
      return { oid: null };
    }
  }

  /**
   * Get object ID at path in tree or index stage
   * @param dir - Git repository directory
   * @param params.path - File path to lookup
   * @param params.tree - Tree object ID to search in (e.g., HEAD tree)
   * @param params.stage - Index stage number (0=normal, 1=ancestor, 2=ours, 3=theirs during merge)
   */
  private async getOidAtPath(dir: string, params: any): Promise<any> {
    const { path, tree, stage } = params;

    try {
      // If stage is provided, read from git index at that stage
      if (stage !== undefined) {
        const { stdout } = await this.execGit(['ls-files', '--stage', path], { cwd: dir });

        // Parse output: <mode> <hash> <stage> <path>
        // Example: "100644 abc123... 0	path/to/file.txt"
        const lines = stdout.split('\n').filter(l => l.trim());

        for (const line of lines) {
          const match = line.match(/^(\d+)\s+([a-f0-9]+)\s+(\d+)\s+(.+)$/);
          if (match) {
            const fileStage = parseInt(match[3], 10);
            const filePath = match[4];

            // Match both stage number and path
            if (fileStage === stage && filePath === path) {
              return { oid: match[2] };
            }
          }
        }

        return { oid: null };
      }

      // If tree is provided, read from tree object (original behavior)
      if (tree) {
        const { stdout } = await this.execGit(['ls-tree', tree, path], { cwd: dir });
        const match = stdout.match(/^(\d+)\s+(\w+)\s+([a-f0-9]+)\s+(.+)$/);
        if (match) {
          return { oid: match[3] };
        }
      }

      return { oid: null };
    } catch (error) {
      return { oid: null };
    }
  }

  /**
   * List files in ref
   */
  private async listFiles(dir: string, params: any): Promise<any> {
    const { ref } = params;
    try {
      const { stdout } = await this.execGit(['ls-tree', '-r', '--name-only', ref || 'HEAD'], { cwd: dir });
      const files = stdout.split('\n').filter(f => f.trim());
      return { files };
    } catch (error) {
      return { files: [] };
    }
  }

  /**
   * Resolve ref to oid
   */
  private async resolveRef(dir: string, params: any): Promise<any> {
    const { ref } = params;
    try {
      const { stdout } = await this.execGit(['rev-parse', ref], { cwd: dir });
      return { oid: stdout.trim() };
    } catch (error) {
      return { oid: null };
    }
  }

  /**
   * Get current branch
   */
  private async currentBranch(dir: string, params: any): Promise<any> {
    try {
      const args = params.fullname
        ? ['symbolic-ref', 'HEAD']
        : ['symbolic-ref', '--short', 'HEAD'];
      const { stdout } = await this.execGit(args, { cwd: dir });
      return { branch: stdout.trim() };
    } catch {
      return { branch: null }; // Detached HEAD
    }
  }

  /**
   * Get commit history
   */
  private async log(dir: string, params: any): Promise<any> {
    const args = [
      'log',
      '--format=%H%n%T%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%B%n--END-COMMIT--',
      params.ref || 'HEAD',
    ];

    if (params.depth) {
      args.push(`-${params.depth}`);
    }

    const { stdout } = await this.execGit(args, { cwd: dir });
    const commits = [];
    const commitTexts = stdout.split('--END-COMMIT--\n').filter((t) => t.trim());

    for (const commitText of commitTexts) {
      const lines = commitText.trim().split('\n');
      commits.push({
        oid: lines[0],
        commit: {
          tree: lines[1],
          parent: lines[2] ? lines[2].split(' ') : [],
          author: {
            name: lines[3],
            email: lines[4],
            timestamp: parseInt(lines[5], 10),
            timezoneOffset: 0,
          },
          committer: {
            name: lines[6],
            email: lines[7],
            timestamp: parseInt(lines[8], 10),
            timezoneOffset: 0,
          },
          message: lines.slice(9).join('\n'),
        },
      });
    }

    return { commits };
  }

  /**
   * Get working directory status
   */
  private async status(dir: string, params: any): Promise<any> {
    // Use --porcelain=v1 with -M for rename detection and -C for copy detection
    const { stdout } = await this.execGit(['status', '--porcelain=v1', '-M'], { cwd: dir });
    const result: Array<{ path: string; status: string }> = [];

    // Extract filepath filter from params (for single-file status queries)
    const filterFilepath = params?.filepath;

    // Conflict status codes from git documentation
    const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

    const lines = stdout.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const gitStatus = line.substring(0, 2);
      let filepath = line.substring(3);

      // Handle rename format: "R  old_name -> new_name"
      let isRenamed = false;
      if (gitStatus.startsWith('R')) {
        const renameMatch = filepath.match(/^(.+)\s+->\s+(.+)$/);
        if (renameMatch) {
          filepath = renameMatch[2]; // Use new filename
          isRenamed = true;
        }
      }

      // Skip if we're filtering for a specific filepath and this isn't it
      if (filterFilepath && filepath !== filterFilepath) {
        continue;
      }

      // Check if this is a conflict
      const isConflict = conflictCodes.has(gitStatus);

      // Direct mapping from git porcelain codes to status strings
      let status: string;
      switch (gitStatus) {
        // Untracked/Ignored
        case '??':
          status = ' ?';
          break;
        case '!!':
          status = '!!';
          break;

        // Added
        case 'A ':
          status = 'A ';
          break;
        case 'AM':
          status = 'AM';
          break;
        case 'AD':
          status = 'AD';
          break;

        // Modified
        case 'M ':
          status = 'M ';
          break;
        case ' M':
          status = ' M';
          break;
        case 'MM':
          status = 'MM';
          break;

        // Deleted
        case 'D ':
          status = 'D ';
          break;
        case ' D':
          status = ' D';
          break;
        case 'MD':
          status = 'MD';
          break;

        // Renamed - check if file was new (not in HEAD)
        case 'R ':
          // For renamed files, check if they existed in HEAD
          // If not in HEAD, treat as Added instead of Renamed
          status = await this.isFileInHead(dir, filepath) ? 'R ' : 'A ';
          break;
        case ' R':
          status = ' R';
          break;

        // Copied
        case 'C ':
          status = 'C ';
          break;
        case ' C':
          status = ' C';
          break;

        // Type changed
        case 'T ':
          status = 'T ';
          break;
        case ' T':
          status = ' T';
          break;

        // Conflicts (all marked with !)
        case 'DD':
        case 'AU':
        case 'UD':
        case 'UA':
        case 'DU':
        case 'AA':
        case 'UU':
          status = gitStatus;
          break;

        // No changes
        case '  ':
        default:
          status = '  ';
          break;
      }

      // Add conflict marker
      status += isConflict ? '!' : ' ';

      result.push({ path: filepath, status });
    }

    return result;
  }

  /**
   * Get status counts (conflicts, changes, fileCount)
   */
  private async statusCounts(dir: string, params: any): Promise<any> {
    const statusArray = await this.status(dir, params);
    let conflicts = 0;
    let changes = 0;

    for (const { status } of statusArray) {
      // Check for conflict marker (3rd character is '!')
      if (status[2] === '!') conflicts++;
      // Check for changes (not '  ')
      if (status.substring(0, 2) !== '  ') changes++;
    }

    return {
      conflicts,
      changes,
      fileCount: statusArray.length
    };
  }

  /**
   * Stage files
   */
  private async add(dir: string, params: any, socket: AuthenticatedSocket): Promise<{ success: boolean }> {
    // Skip if no files to add (prevents "No pathspec was given" error)
    if (!params.filepaths || params.filepaths.length === 0) {
      return { success: true };
    }

    await this.execGit(['add', ...params.filepaths], { cwd: dir });

    // Send change notification
    socket.broadcast.emit('rpc', {
      jsonrpc: '2.0',
      method: 'git.changed',
      params: { dir },
    });

    return { success: true };
  }

  /**
   * Remove files from index (git rm --cached)
   */
  private async remove(dir: string, params: any, socket: AuthenticatedSocket): Promise<{ success: boolean }> {
    // Skip if no files to remove (prevents "No pathspec was given" error)
    if (!params.filepaths || params.filepaths.length === 0) {
      return { success: true };
    }

    await this.execGit(['rm', '--cached', ...params.filepaths], { cwd: dir });

    // Send change notification
    socket.broadcast.emit('rpc', {
      jsonrpc: '2.0',
      method: 'git.changed',
      params: { dir },
    });

    return { success: true };
  }

  /**
   * Reset file(s) in index to match ref (git reset <ref> -- <filepath(s)>)
   */
  private async resetIndex(dir: string, params: any, socket: AuthenticatedSocket): Promise<{ success: boolean }> {
    const ref = params.ref || 'HEAD';

    // Handle both single filepath and multiple filepaths
    if (params.filepaths && Array.isArray(params.filepaths)) {
      // Skip if no files to reset (prevents "No pathspec was given" error)
      if (params.filepaths.length === 0) {
        return { success: true };
      }

      await this.execGit(['reset', ref, '--', ...params.filepaths], { cwd: dir });
    } else if (params.filepath) {
      // Reset single file (backward compatibility)
      await this.execGit(['reset', ref, '--', params.filepath], { cwd: dir });
    } else {
      return { success: true };
    }

    // Send change notification
    socket.broadcast.emit('rpc', {
      jsonrpc: '2.0',
      method: 'git.changed',
      params: { dir },
    });

    return { success: true };
  }

  /**
   * Create commit
   */
  private async commit(dir: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    const env = {
      GIT_AUTHOR_NAME: params.author.name,
      GIT_AUTHOR_EMAIL: params.author.email,
      GIT_COMMITTER_NAME: params.author.name,
      GIT_COMMITTER_EMAIL: params.author.email,
    };

    await this.execGit(['commit', '-m', params.message], { cwd: dir, env });

    const { stdout } = await this.execGit(['rev-parse', 'HEAD'], { cwd: dir });
    const oid = stdout.trim();

    // Send change notification
    socket.broadcast.emit('rpc', {
      jsonrpc: '2.0',
      method: 'git.changed',
      params: { dir },
    });

    return { oid };
  }

  /**
   * Get config value
   */
  private async getConfig(dir: string, params: any): Promise<any> {
    try {
      const { stdout } = await this.execGit(['config', '--get', params.path], { cwd: dir });
      return { value: stdout.trim() };
    } catch (error: any) {
      // Git returns exit code 1 if config key doesn't exist
      if (error.message.includes('code 1')) {
        return { value: undefined };
      }
      throw error;
    }
  }

  /**
   * Set config value
   */
  private async setConfig(dir: string, params: any): Promise<{ success: boolean }> {
    const { path, value, append } = params;

    if (value === undefined) {
      // Delete the config entry
      try {
        await this.execGit(['config', '--unset', path], { cwd: dir });
      } catch (error: any) {
        // Ignore error if key doesn't exist
        if (!error.message.includes('code 5')) {
          throw error;
        }
      }
    } else if (append) {
      // Append to existing value (for multi-valued config options)
      await this.execGit(['config', '--add', path, String(value)], { cwd: dir });
    } else {
      // Set/replace the value
      await this.execGit(['config', path, String(value)], { cwd: dir });
    }

    return { success: true };
  }

  /**
   * List branches
   */
  private async listBranches(dir: string, params: any): Promise<any> {
    const args = params.remote ? ['branch', '-r'] : ['branch'];
    const { stdout } = await this.execGit(args, { cwd: dir });

    const branches = stdout
      .split('\n')
      .map((line) => line.trim().replace(/^\* /, ''))
      .filter((line) => line);

    return { branches };
  }

  /**
   * Checkout branch or commit
   */
  private async checkout(dir: string, params: any): Promise<{ success: boolean }> {
    const args = ['checkout', params.ref];
    if (params.force) {
      args.push('--force');
    }

    await this.execGit(args, { cwd: dir });

    return { success: true };
  }

  /**
   * Initialize repository
   */
  private async init(dir: string, params: any): Promise<{ success: boolean }> {
    const args = ['init'];
    if (params.defaultBranch) {
      args.push('--initial-branch', params.defaultBranch);
    }

    await this.execGit(args, { cwd: dir });
    return { success: true };
  }

  /**
   * List git remotes
   */
  private async listRemotes(dir: string, params: any): Promise<any> {
    try {
      const { stdout } = await this.execGit(['remote', '-v'], { cwd: dir });
      const remotes: Array<{ remote: string; url: string }> = [];

      const lines = stdout.split('\n').filter(l => l.trim());
      const seen = new Set<string>();

      for (const line of lines) {
        const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
        if (match && !seen.has(match[1])) {
          remotes.push({
            remote: match[1],
            url: match[2]
          });
          seen.add(match[1]);
        }
      }

      return { remotes };
    } catch (error) {
      return { remotes: [] };
    }
  }

  /**
   * Add git remote
   */
  private async addRemote(dir: string, params: any): Promise<{ success: boolean }> {
    const { remote, url } = params;
    await this.execGit(['remote', 'add', remote, url], { cwd: dir });
    return { success: true };
  }

  /**
   * Delete git remote
   */
  private async deleteRemote(dir: string, params: any): Promise<{ success: boolean }> {
    const { remote } = params;
    await this.execGit(['remote', 'remove', remote], { cwd: dir });
    return { success: true };
  }

  /**
   * Clear git index (remove cached files)
   */
  private async clearIndex(dir: string, params: any): Promise<{ success: boolean }> {
    try {
      await this.execGit(['rm', '-r', '--cached', '-f', '.'], { cwd: dir });
      return { success: true };
    } catch (error) {
      // If no files in index, this is fine
      return { success: true };
    }
  }

  /**
   * Check if file is ignored by .gitignore
   */
  private async isIgnored(dir: string, params: any): Promise<boolean> {
    const { filepath } = params;
    try {
      await this.execGit(['check-ignore', filepath], { cwd: dir });
      // Exit code 0 means file is ignored
      return true;
    } catch (error) {
      // Exit code 1 means file is not ignored
      return false;
    }
  }

  /**
   * Check if a file exists in HEAD commit
   * Used to determine if a renamed file is truly new or was previously committed
   */
  private async isFileInHead(dir: string, filepath: string): Promise<boolean> {
    try {
      // Use git ls-tree to check if file exists in HEAD
      // This is faster than checking out or reading the entire tree
      const { stdout } = await this.execGit(['ls-tree', 'HEAD', '--', filepath], { cwd: dir });
      return stdout.trim().length > 0;
    } catch (error) {
      // File doesn't exist in HEAD or no commits yet
      return false;
    }
  }

  /**
   * Request authentication from client (server-to-client RPC)
   */
  private async requestAuth(socket: AuthenticatedSocket, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

      // Set up one-time response listener
      const responseHandler = (response: any) => {
        if (response.id === requestId) {
          socket.off('rpc', responseHandler);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        }
      };

      socket.on('rpc', responseHandler);

      // Send request to client
      socket.emit('rpc', {
        jsonrpc: '2.0',
        method: 'git.requestAuth',
        params: {
          url: params.url,
          attempt: params.attempt || 1,
        },
        id: requestId,
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        socket.off('rpc', responseHandler);
        reject(new Error('Authentication request timed out'));
      }, 30000);
    });
  }
}
