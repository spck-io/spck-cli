import { describe, it, expect } from 'vitest';
import { fit, formatDuration, stripAnsi, truncate, visibleWidth, wrap } from '../screen.js';

const red = (s: string) => `\x1b[31m${s}\x1b[39m`;

describe('dashboard screen helpers', () => {
  it('measures colored and wide text by terminal columns', () => {
    expect(visibleWidth(red('abc'))).toBe(3);
    expect(visibleWidth('日本')).toBe(4);
  });

  it('truncates colored text without breaking escape sequences', () => {
    const cut = truncate(red('hello world'), 5);
    expect(stripAnsi(cut)).toBe('hello');
    expect(cut.startsWith('\x1b[31m')).toBe(true);
    expect(cut.endsWith('\x1b[0m')).toBe(true);
  });

  it('never splits a wide character across the limit', () => {
    expect(truncate('日本語', 3)).toBe('日');
  });

  it('pads to an exact width', () => {
    expect(visibleWidth(fit(red('ab'), 6))).toBe(6);
    expect(visibleWidth(fit('abcdefgh', 6))).toBe(6);
  });

  it('wraps on word boundaries', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('formats durations compactly', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration((3 * 60 + 5) * 60_000)).toBe('3h 05m');
    expect(formatDuration(50 * 3600_000)).toBe('2d 2h');
  });
});
