/**
 * Captures console output so the dashboard can keep logs off screen until
 * the user opens the log view. Before the dashboard starts (and after it
 * stops) output is passed through to the terminal as usual.
 */

import { format } from 'util';
import { sanitizeLine } from './screen.js';

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
  private listeners = new Set<(added: number) => void>();
  private notice: LogEntry | undefined;
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

  /**
   * Most recent warning or error, if any. A multi-line message is represented
   * by its first line with text, not a stack frame or trailing blank line.
   */
  lastNotice(): LogEntry | undefined {
    return this.notice;
  }

  /** The listener is told how many entries were added. */
  onAppend(listener: (added: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private append(level: LogLevel, text: string): void {
    const time = Date.now();
    const added = text.split('\n').map((line) => ({ time, level, text: sanitizeLine(line) }));
    this.entries.push(...added);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    if (level !== 'info') {
      this.notice = added.find((entry) => entry.text.trim() !== '') ?? this.notice;
    }
    for (const listener of this.listeners) listener(added.length);
  }
}
