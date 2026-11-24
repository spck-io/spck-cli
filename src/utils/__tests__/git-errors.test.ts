import { describe, it, expect } from 'vitest';
import { GitCommandError, classifyGitFailure } from '../git-errors.js';

describe('classifyGitFailure', () => {
  it.each([
    ['AuthFailed', "remote: Unauthorized\nfatal: Authentication failed for 'http://localhost:3300/tester/repo.git/'"],
    ['AuthFailed', "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
    ['AuthFailed', 'git@localhost: Permission denied (publickey).\nfatal: Could not read from remote repository.'],
    ['AuthFailed', "fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 403"],
    ['PushRejected', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'http://localhost:3300/tester/repo.git\''],
    ['PushRejected', ' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs'],
    ['PushDeclined', ' ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs'],
    ['NotFastForward', 'hint: Diverging branches can\'t be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.'],
    ['NotFastForward', 'hint: You have divergent branches and need to specify how to reconcile them.\nfatal: Need to specify how to reconcile divergent branches.'],
    ['MergeConflict', 'Auto-merging notes.md\nCONFLICT (content): Merge conflict in notes.md\nAutomatic merge failed; fix conflicts and then commit the result.'],
    ['LocalChanges', 'error: Your local changes to the following files would be overwritten by merge:\n\tnotes.md\nPlease commit your changes or stash them before you merge.'],
    ['HostKeyFailed', 'Host key verification failed.\nfatal: Could not read from remote repository.'],
    ['RepositoryNotFound', "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found"],
    ['RepositoryNotFound', "fatal: '/tmp/missing' does not appear to be a git repository"],
    ['RemoteRefNotFound', "fatal: couldn't find remote ref feature"],
    ['NetworkError', "fatal: unable to access 'https://nowhere.invalid/repo.git/': Could not resolve host: nowhere.invalid"],
    ['NetworkError', 'ssh: connect to host localhost port 2222: Connection refused\nfatal: Could not read from remote repository.'],
  ])('reads %s', (reason, output) => {
    expect(classifyGitFailure(output)).toBe(reason);
  });

  it('leaves other failures unclassified', () => {
    expect(classifyGitFailure("fatal: bad object 0000000000000000000000000000000000000000")).toBeUndefined();
    expect(classifyGitFailure('')).toBeUndefined();
  });
});

describe('GitCommandError', () => {
  it('names the reason in its message but keeps the output out of it', () => {
    const output = "fatal: Authentication failed for 'http://host/private/path.git/'";
    const error = new GitCommandError(128, 'AuthFailed', output);
    expect(error.message).toBe('Git command failed with exit code 128 (authentication failed)');
    expect(error.reason).toBe('AuthFailed');
    expect(error.output).toBe(output);
    expect(String(error)).not.toContain('private/path');
    expect(JSON.stringify(error)).not.toContain('private/path');
    expect(new GitCommandError(1).message).toBe('Git command failed with exit code 1');
  });
});
