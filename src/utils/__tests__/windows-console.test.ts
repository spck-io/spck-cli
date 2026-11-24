import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';
import { consoleHasCjkFont, isClassicWindowsConsole, measureConsoleWidths, wideInConsole } from '../windows-console.js';

describe('isClassicWindowsConsole()', () => {
  it('is false outside Windows', () => {
    expect(isClassicWindowsConsole('linux', {})).toBe(false);
    expect(isClassicWindowsConsole('darwin', {})).toBe(false);
  });

  it('is true on Windows when no other terminal identifies itself', () => {
    expect(isClassicWindowsConsole('win32', {})).toBe(true);
  });

  it.each([
    ['WT_SESSION', 'f2c4d6e8-0000-0000-0000-000000000000'],
    ['TERM_PROGRAM', 'vscode'],
    ['ConEmuPID', '1234'],
    ['TERMINAL_EMULATOR', 'JetBrains-JediTerm'],
    ['TERM', 'xterm-256color'],
  ])('is false in Windows terminals that set %s', (name, value) => {
    expect(isClassicWindowsConsole('win32', { [name]: value })).toBe(false);
  });
});

// How a Windows 10 console lays out the dashboard's symbols in each font, as
// measured in one
const NSIMSUN = '·●○★↑↓←→—–…‘’“”'; // Chinese (新宋体)
const LUCIDA_CONSOLE = '●★';
const SYMBOLS = '·●○★↑↓←→—–…‘’“”';

/**
 * A console that answers cursor position requests for symbols printed at the
 * start of a line, laying out `wide` two columns wide. Like Windows 10, it
 * answers requests written together in reverse order.
 */
function fakeConsole(wide: string, { answer = true, typed = '' } = {}) {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(mode: boolean) { input.isRaw = mode; },
  });
  let output = '';
  const writable = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      const replies = [...String(chunk).matchAll(/\r(.)\x1b\[6n/gu)].map(([, ch]) => `\x1b[1;${wide.includes(ch) ? 3 : 2}R`);
      if (answer && replies.length) {
        const data = typed + replies.reverse().join('');
        typed = '';
        setImmediate(() => input.write(data));
      }
      done();
    },
  });
  return { input, writable, output: () => output };
}

describe('measureConsoleWidths()', () => {
  it('finds the symbols a Chinese font lays out two columns wide', async () => {
    const { input, writable } = fakeConsole(NSIMSUN);
    await measureConsoleWidths(SYMBOLS, input, writable);
    expect(wideInConsole(SYMBOLS + 'aé█')).toEqual([...NSIMSUN]);
    expect(consoleHasCjkFont()).toBe(true);
  });

  it('tells Lucida Console, with a wide ●, from a CJK font', async () => {
    const { input, writable } = fakeConsole(LUCIDA_CONSOLE);
    await measureConsoleWidths(SYMBOLS, input, writable);
    expect(wideInConsole(SYMBOLS)).toEqual([...LUCIDA_CONSOLE]);
    expect(consoleHasCjkFont()).toBe(false);
  });

  it('measures on the alternate screen, one symbol at a time, and restores the input', async () => {
    const { input, writable, output } = fakeConsole(NSIMSUN);
    await measureConsoleWidths('·●', input, writable);
    expect(output()).toBe('\x1b[?1049h\r·\x1b[6n\r●\x1b[6n\r…\x1b[6n\r\x1b[K\x1b[?1049l');
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('keeps keys typed during the measurement for whoever reads next', async () => {
    const { input, writable } = fakeConsole('', { typed: 'y\r' });
    await measureConsoleWidths('·', input, writable);
    expect(String(input.read())).toBe('y\r');
  });

  it('measures nothing when the console does not answer', async () => {
    const { input, writable } = fakeConsole(NSIMSUN, { answer: false });
    await measureConsoleWidths(SYMBOLS, input, writable, 20);
    expect(wideInConsole(SYMBOLS)).toEqual([]);
    expect(consoleHasCjkFont()).toBeNull();
    expect(input.isRaw).toBe(false);
  });

  it('measures nothing when the input is not a console', async () => {
    const { input, writable, output } = fakeConsole(NSIMSUN);
    input.setRawMode = () => { throw new Error('not a TTY'); };
    await measureConsoleWidths(SYMBOLS, input, writable);
    expect(consoleHasCjkFont()).toBeNull();
    expect(output()).toBe('');
  });
});
