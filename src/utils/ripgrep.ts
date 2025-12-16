/**
 * Ripgrep wrapper utility
 *
 * Uses system-installed ripgrep (rg) if available
 */

import { spawn } from 'child_process';

/**
 * Get the ripgrep command name for the current platform
 */
export function getRipgrepCommand(): string {
  // On Windows, try both 'rg.exe' and 'rg'
  // On Unix-like systems, use 'rg'
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

/**
 * Check if ripgrep is available on the system PATH
 */
export async function isRipgrepAvailable(): Promise<boolean> {
  const rgCommand = getRipgrepCommand();

  // Try to execute ripgrep --version to verify it works
  return new Promise((resolve) => {
    try {
      const proc = spawn(rgCommand, ['--version'], {
        cwd: process.cwd(),
        stdio: 'ignore',
        shell: false
      });

      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    } catch (err) {
      resolve(false)
    }
  });
}

/**
 * Execute ripgrep search (buffered - waits for completion)
 */
export async function executeRipgrep(
  args: string[],
  options?: {
    timeout?: number;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const rgCommand = getRipgrepCommand();

  return new Promise((resolve, reject) => {
    const proc = spawn(rgCommand, args, {
      cwd: process.cwd(),
      stdio: 'pipe',
      shell: false
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Set timeout if specified
    const timeout = options?.timeout;
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout) {
      timeoutId = setTimeout(() => {
        killed = true;
        proc.kill();
        reject(new Error(`Ripgrep execution timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!killed) {
        reject(error);
      }
    });

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!killed) {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1
        });
      }
    });
  });
}

/**
 * Execute ripgrep search with streaming output
 * Calls onLine for each line of output as it arrives
 */
export async function executeRipgrepStream(
  args: string[],
  options: {
    timeout?: number;
    onLine: (line: string) => void;
  }
): Promise<{ exitCode: number }> {
  const rgCommand = getRipgrepCommand();

  return new Promise((resolve, reject) => {
    const proc = spawn(rgCommand, args, {
      cwd: process.cwd(),
      stdio: 'pipe',
      shell: false
    });

    let killed = false;
    let buffer = '';

    // Set timeout if specified
    const timeout = options.timeout;
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout) {
      timeoutId = setTimeout(() => {
        killed = true;
        proc.kill();
        reject(new Error(`Ripgrep execution timed out after ${timeout}ms`));
      }, timeout);
    }

    // Process stdout line by line as it arrives
    proc.stdout?.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');

      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || '';

      // Process complete lines
      for (const line of lines) {
        if (line.trim()) {
          options.onLine(line);
        }
      }
    });

    proc.stderr?.on('data', (data) => {
      // Ignore stderr for now
    });

    proc.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!killed) {
        reject(error);
      }
    });

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);

      // Process any remaining buffered data
      if (buffer.trim()) {
        options.onLine(buffer);
      }

      if (!killed) {
        resolve({
          exitCode: code ?? -1
        });
      }
    });
  });
}
