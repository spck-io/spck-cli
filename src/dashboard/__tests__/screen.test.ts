import { describe, it, expect } from 'vitest';
import { fit, formatBytes, formatDuration, sanitizeLine, skipColumns, stripAnsi, truncate, visibleWidth, wrap } from '../screen.js';

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

  it('splits text with no spaces instead of dropping it', () => {
    expect(wrap('日本語のテキスト', 6)).toEqual(['日本語', 'のテキ', 'スト']);
    expect(wrap('Secret: abcdefgh', 5)).toEqual(['Secre', 't:', 'abcde', 'fgh']);
  });

  it('keeps colors but removes anything else that could disturb the screen', () => {
    expect(sanitizeLine(red('ok'))).toBe(red('ok'));
    expect(sanitizeLine('a\x1b[2Jb\x1b[10;10Hc')).toBe('abc');
    expect(sanitizeLine('a\x1b]0;title\x07b')).toBe('ab');
    expect(sanitizeLine('a\rb\x07c\x1bd')).toBe('abcd');
    expect(sanitizeLine('a\tb')).toBe('a    b');
  });

  it('skips columns while keeping colors and handling wide characters', () => {
    expect(skipColumns(red('hello'), 2)).toBe(red('llo'));
    expect(skipColumns('日本語', 1)).toBe(' 本語');
    expect(skipColumns('abc', 0)).toBe('abc');
  });

  it('formats durations compactly', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration((3 * 60 + 5) * 60_000)).toBe('3h 05m');
    expect(formatDuration(50 * 3600_000)).toBe('2d 2h');
  });

  it('formats buffer sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024)).toBe('50 KB');
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });
});
