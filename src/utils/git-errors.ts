/**
 * Why a Git command failed, read from its output.
 *
 * Git's output can contain local paths, so it never goes to the editor. The
 * editor gets one of these reasons instead and shows its own message for it.
 */
export type GitFailureReason =
  | 'AuthCancelled'
  | 'AuthFailed'
  | 'PushRejected'
  | 'PushDeclined'
  | 'NotFastForward'
  | 'MergeConflict'
  | 'LocalChanges'
  | 'RepositoryNotFound'
  | 'RemoteRefNotFound'
  | 'HostKeyFailed'
  | 'NetworkError';

// In order: the first match wins
const PATTERNS: Array<[GitFailureReason, RegExp]> = [
  ['MergeConflict', /^CONFLICT \(|Automatic merge failed/m],
  ['LocalChanges', /local changes to the following files would be overwritten|untracked working tree files would be overwritten|Please commit your changes or stash them/],
  ['PushRejected', /! \[rejected\].*\((?:non-fast-forward|fetch first)\)/],
  ['PushDeclined', /! \[remote rejected\]|pre-receive hook declined/],
  ['NotFastForward', /Not possible to fast-forward|divergent branches|Need to specify how to reconcile/],
  ['HostKeyFailed', /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/],
  ['AuthFailed', /Authentication failed|could not read (?:Username|Password)|Invalid username or password|HTTP Basic: Access denied|The requested URL returned error: 40[13]|Permission denied \((?:publickey|password|keyboard-interactive)|incorrect passphrase/i],
  ['RepositoryNotFound', /Repository not found|repository '.*' not found|does not appear to be a git repository|The requested URL returned error: 404/i],
  ['RemoteRefNotFound', /couldn't find remote ref|Remote branch .* not found/i],
  ['NetworkError', /Could not resolve host|Could not resolve hostname|Failed to connect to|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host|SSL certificate problem|Connection reset|RPC failed|early EOF/i],
];

export function classifyGitFailure(output: string): GitFailureReason | undefined {
  return PATTERNS.find(([, pattern]) => pattern.test(output))?.[0];
}

const DESCRIPTIONS: Record<GitFailureReason, string> = {
  AuthCancelled: 'sign-in cancelled',
  AuthFailed: 'authentication failed',
  PushRejected: 'the remote has commits that are not in the local branch',
  PushDeclined: 'the remote declined the push',
  NotFastForward: 'the local and remote branches have diverged',
  MergeConflict: 'merge conflicts',
  LocalChanges: 'local changes would be overwritten',
  RepositoryNotFound: 'repository not found',
  RemoteRefNotFound: 'remote branch not found',
  HostKeyFailed: 'SSH host key verification failed',
  NetworkError: 'could not reach the Git server',
};

/**
 * A Git command that exited with an error. The message names the reason but
 * keeps Git's output out; `output` is for the CLI's own use only.
 */
export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly reason?: GitFailureReason;
  declare readonly output: string;

  constructor(exitCode: number | null, reason?: GitFailureReason, output = '') {
    super(`Git command failed with exit code ${exitCode}` + (reason ? ` (${DESCRIPTIONS[reason]})` : ''));
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
    this.reason = reason;
    // Not enumerable, so it stays out of logged or serialized errors
    Object.defineProperty(this, 'output', { value: output });
  }
}
