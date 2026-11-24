import { afterEach, describe, expect, it, vi } from 'vitest';
import qrcode from 'qrcode-terminal';
import { printQr, renderQr, terminalQrStyle } from '../qr.js';

// Whether the console draws block characters wide depends on the console
// running the tests: pin it
const blocks = vi.hoisted(() => ({ wide: [] as string[] }));
vi.mock('../windows-console.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../windows-console.js')>()),
  wideInConsole: () => blocks.wide,
}));

const URL_TEXT = 'spck://connect?clientId=abcdefghijkl&secret=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR&rs=cli-na-1.spck.io';

/** Light (true) / dark (false) modules of a half-block drawing, margin included. */
function halfBlockModules(lines: string[]): boolean[][] {
  const rows = lines.flatMap((line) => [
    [...line].map((ch) => ch === '█' || ch === '▀'),
    [...line].map((ch) => ch === '█' || ch === '▄'),
  ]);
  // The top half of the first line is outside the code, and so is the bottom
  // half of the last one when the code has an odd number of rows
  const size = lines[0].length;
  return rows.slice(1, 1 + size);
}

/** Light (true) / dark (false) modules of a cell drawing. */
function cellModules(lines: string[]): boolean[][] {
  return lines.map((line) => {
    const modules: boolean[] = [];
    let light = false;
    for (const [, color, cell] of line.matchAll(/\x1b\[(\d+)m|( {2})/g)) {
      if (color) light = color === '107';
      else if (cell) modules.push(light);
    }
    return modules;
  });
}

describe('terminalQrStyle()', () => {
  it('uses half blocks outside Windows', () => {
    expect(terminalQrStyle('linux', {})).toBe('halfBlocks');
    expect(terminalQrStyle('darwin', {})).toBe('halfBlocks');
  });

  it('uses cells in the classic Windows console', () => {
    expect(terminalQrStyle('win32', {})).toBe('cells');
  });

  it.each([
    ['WT_SESSION', 'f2c4d6e8-0000-0000-0000-000000000000'],
    ['TERM_PROGRAM', 'vscode'],
    ['ConEmuPID', '1234'],
    ['TERMINAL_EMULATOR', 'JetBrains-JediTerm'],
    ['TERM', 'xterm-256color'],
  ])('uses half blocks in Windows terminals that set %s', (name, value) => {
    expect(terminalQrStyle('win32', { [name]: value })).toBe('halfBlocks');
  });
});

describe('renderQr()', () => {
  it('draws half blocks exactly as qrcode-terminal does', () => {
    let expected = '';
    qrcode.generate(URL_TEXT, { small: true }, (output) => { expected = output; });
    expect(renderQr(URL_TEXT, 'halfBlocks').join('\n')).toBe(expected.trimEnd());
  });

  it('draws cells as square modules of spaces on colored backgrounds', () => {
    const lines = renderQr(URL_TEXT, 'cells');
    for (const line of lines) {
      const plain = line.replace(/\x1b\[\d+m/g, '');
      expect(plain).toMatch(/^ +$/);
      expect(plain.length).toBe(lines.length * 2);
      expect(line.endsWith('\x1b[0m')).toBe(true);
    }
  });

  it('draws the same code in both styles', () => {
    const cells = cellModules(renderQr(URL_TEXT, 'cells'));
    expect(cells).toEqual(halfBlockModules(renderQr(URL_TEXT, 'halfBlocks')));
    // A light margin all around
    expect(cells[0].every(Boolean)).toBe(true);
    expect(cells[cells.length - 1].every(Boolean)).toBe(true);
    expect(cells.every((row) => row[0] && row[row.length - 1])).toBe(true);
  });
});

describe('printQr()', () => {
  const original = { platform: process.platform, isTTY: process.stdout.isTTY, rows: process.stdout.rows, columns: process.stdout.columns };

  function classicWindowsConsole(columns: number, rows: number) {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const name of ['WT_SESSION', 'TERM_PROGRAM', 'ConEmuPID', 'TERMINAL_EMULATOR', 'TERM']) vi.stubEnv(name, undefined);
    Object.assign(process.stdout, { isTTY: true, columns, rows });
  }

  afterEach(() => {
    blocks.wide = [];
    Object.defineProperty(process, 'platform', { value: original.platform });
    Object.assign(process.stdout, { isTTY: original.isTTY, columns: original.columns, rows: original.rows });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prints cells in the classic Windows console when the whole code fits', () => {
    classicWindowsConsole(120, 50);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printQr(URL_TEXT);
    expect(log).toHaveBeenCalledExactlyOnceWith(renderQr(URL_TEXT, 'cells').join('\n'));
  });

  it('prints half blocks when cells would not fit on screen', () => {
    classicWindowsConsole(120, 30);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printQr(URL_TEXT);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0]).trimEnd()).toBe(renderQr(URL_TEXT, 'halfBlocks').join('\n'));
  });

  it('prints cells anyway when the console draws block characters wide', () => {
    classicWindowsConsole(120, 30);
    blocks.wide = ['█', '▄'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printQr(URL_TEXT);
    // Taller than the window, but scrollable; half blocks couldn't be scanned
    expect(log).toHaveBeenCalledExactlyOnceWith(renderQr(URL_TEXT, 'cells').join('\n'));
  });
});
