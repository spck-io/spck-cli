/**
 * Captures console output so the dashboard can keep logs off screen until
 * the user opens the log view. Before the dashboard starts (and after it
 * stops) output is passed through to the terminal as usual.
 */

import { format } from 'util';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 2000;

type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';
const LEVELS: Record<ConsoleMethod, LogLevel> = {
  log: 'info',
  info: 'info',
  debug: 'info',
  warn: 'warn',
  error: 'error',
};

export class LogBuffer {
  readonly entries: LogEntry[] = [];
  private listeners = new Set<() => void>();
  private originals: Partial<Record<ConsoleMethod, (...args: any[]) => void>> = {};
  private passthrough = true;

  install(): void {
    if (this.originals.log) return;
    for (const method of Object.keys(LEVELS) as ConsoleMethod[]) {
      const original = console[method];
      this.originals[method] = original;
      console[method] = (...args: any[]) => {
        this.append(LEVELS[method], format(...args));
        if (this.passthrough) original.apply(console, args);
      };
    }
  }

  uninstall(): void {
    for (const [method, original] of Object.entries(this.originals)) {
      console[method as ConsoleMethod] = original;
    }
    this.originals = {};
  }

  /** When false, output is only buffered (the dashboard owns the screen). */
  setPassthrough(passthrough: boolean): void {
    this.passthrough = passthrough;
  }

  /** Most recent warning or error, if any. */
  lastNotice(): LogEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].level !== 'info') return this.entries[i];
    }
    return undefined;
  }

  onAppend(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private append(level: LogLevel, text: string): void {
    const time = Date.now();
    for (const line of text.split('\n')) {
      this.entries.push({ time, level, text: line });
    }
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    for (const listener of this.listeners) listener();
  }
}
