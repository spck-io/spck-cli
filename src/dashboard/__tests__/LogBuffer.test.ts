import { describe, it, expect, afterEach, vi } from 'vitest';
import { LogBuffer } from '../LogBuffer.js';

describe('LogBuffer', () => {
  let buffer: LogBuffer | null = null;

  afterEach(() => {
    buffer?.uninstall();
    buffer = null;
  });

  it('captures console output and only echoes it while passthrough is on', () => {
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    buffer = new LogBuffer();
    buffer.install();

    console.log('visible %d', 1);
    buffer.setPassthrough(false);
    console.log('line a\nline b');

    expect(write).toHaveBeenCalledTimes(1);
    expect(buffer.entries.map(e => e.text)).toEqual(['visible 1', 'line a', 'line b']);
    buffer.uninstall();
    write.mockRestore();
  });

  it('remembers the latest warning or error', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    buffer = new LogBuffer();
    buffer.install();
    buffer.setPassthrough(false);

    console.warn('relay slow');
    console.error('relay gone');
    console.log('all good');

    expect(buffer.lastNotice()).toEqual(expect.objectContaining({ level: 'error', text: 'relay gone' }));
    vi.restoreAllMocks();
  });

  it('restores the original console on uninstall', () => {
    const original = console.log;
    buffer = new LogBuffer();
    buffer.install();
    expect(console.log).not.toBe(original);
    buffer.uninstall();
    expect(console.log).toBe(original);
  });
});
