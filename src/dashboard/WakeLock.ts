/**
 * Keeps the computer from idle-sleeping while the CLI runs, so the editor
 * can stay connected. Node has no wake lock API, so each platform's own
 * tool is run as a helper process that dies with the CLI:
 *   macOS   caffeinate -i -w <pid>
 *   Linux   systemd-inhibit (blocks idle + sleep)
 *   Windows SetThreadExecutionState via PowerShell
 */

import { spawn, ChildProcess } from 'child_process';

export type WakeLockState = 'off' | 'on' | 'unavailable';

interface HelperCommand {
  command: string;
  args: string[];
}

function helperCommand(pid: number): HelperCommand | null {
  switch (process.platform) {
    case 'darwin':
      // -i: prevent idle sleep; -w: release when our process exits
      return { command: 'caffeinate', args: ['-i', '-w', String(pid)] };
    case 'linux':
      return {
        command: 'systemd-inhibit',
        args: [
          '--what=idle:sleep',
          '--who=Spck CLI',
          '--why=Keeping Spck Editor connected',
          '--mode=block',
          // Poll our pid so the inhibitor is released even if we are killed
          'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 5; done`,
        ],
      };
    case 'win32': {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held until our process exits
      const script =
        "$s = Add-Type -Name P -Namespace W -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
        '[void]$s::SetThreadExecutionState([uint32]2147483649);' +
        `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`;
      return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
    }
    default:
      return null;
  }
}

export class WakeLock {
  private child: ChildProcess | null = null;
  private _state: WakeLockState = 'off';
  private _error: string | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    // Helpers already exit with us, but don't leave them for the poll interval.
    process.once('exit', () => this.child?.kill());
  }

  get state(): WakeLockState {
    return this._state;
  }

  /** Why the wake lock could not be held, when state is 'unavailable' */
  get error(): string | null {
    return this._error;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  toggle(): void {
    if (this.child) this.release();
    else this.acquire();
  }

  acquire(): void {
    if (this.child) return;
    const helper = helperCommand(process.pid);
    if (!helper) {
      this.setState('unavailable', `not supported on ${process.platform}`);
      return;
    }

    const child = spawn(helper.command, helper.args, { stdio: 'ignore', windowsHide: true });
    this.child = child;
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null;
      this.setState('unavailable', error.code === 'ENOENT' ? `${helper.command} not found` : error.message);
    });
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.setState('unavailable', `${helper.command} exited (code ${code})`);
    });
    child.unref();
    this.setState('on', null);
  }

  release(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
    this.setState('off', null);
  }

  private setState(state: WakeLockState, error: string | null): void {
    this._state = state;
    this._error = error;
    for (const listener of this.listeners) listener();
  }
}
